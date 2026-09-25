/**
 * pi-sock — unix-socket JSONL RPC for a live pi TUI session.
 *
 * A trimmed fork of Armin Ronacher's session control extension
 * (mitsuhiko/agent-stuff, extensions/control.ts, MIT). The socket lets any local
 * process inject messages into, observe, and abort the running pi session, while
 * the TUI stays attached and fully interactive in the same process.
 *
 * Protocol (newline-delimited JSON over ~/.pi/pi-sock/<name>.sock):
 *
 *   Commands (client -> pi):
 *     {"id":"r1","type":"send","text":"...","mode":"steer"}   steer|follow_up
 *     {"id":"r2","type":"get_state"}
 *     {"id":"r3","type":"get_message"}
 *     {"id":"r4","type":"subscribe","events":["agent_start","turn_end","agent_settled"]}
 *     {"id":"r5","type":"abort"}
 *     {"id":"r6","type":"set_session_name","name":"..."}
 *
 *   Responses (pi -> client):
 *     {"type":"response","command":"...","success":true,"data":...,"id":"r1"}
 *
 *   Events (pushed to subscribed clients, persistent until socket closes):
 *     {"type":"event","event":"agent_settled","data":{"lastAssistant":...}}
 *
 * Send semantics: `pi.sendUserMessage` — the injected text enters the session as a
 * normal user message. When the agent is idle it triggers a turn immediately; while
 * streaming, `mode` selects steering (default) vs follow-up queueing.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	AgentStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const SOCK_DIR = path.join(os.homedir(), ".pi", "pi-sock");
const SOCK_NAME = process.env.PI_SOCK_NAME ?? "main";
const SOCKET_SUFFIX = ".sock";
const STATUS_KEY = "pi-sock";

// ============================================================================
// Wire types
// ============================================================================

interface RpcResponse {
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
	id?: string;
}

interface RpcEvent {
	type: "event";
	event: string;
	data?: unknown;
}

interface RpcSendCommand {
	type: "send";
	text?: string;
	message?: string; // accepted as an alias for text
	mode?: "steer" | "follow_up";
	id?: string;
}

interface RpcGetStateCommand {
	type: "get_state";
	id?: string;
}

interface RpcGetMessageCommand {
	type: "get_message";
	id?: string;
}

interface RpcSubscribeCommand {
	type: "subscribe";
	events?: string[];
	/** get_activity only: include cumulative session stats in the snapshot */
	includeStats?: boolean;
	id?: string;
}

interface RpcGetActivityCommand {
	type: "get_activity";
	includeStats?: boolean;
	id?: string;
}

interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

interface RpcSetSessionNameCommand {
	type: "set_session_name";
	name?: string;
	id?: string;
}

type RpcCommand =
	| RpcSendCommand
	| RpcGetStateCommand
	| RpcGetMessageCommand
	| RpcGetActivityCommand
	| RpcSubscribeCommand
	| RpcAbortCommand
	| RpcSetSessionNameCommand;

const SUBSCRIBABLE_EVENTS = new Set(["agent_start", "turn_end", "agent_settled", "activity_change"]);

// ============================================================================
// pi-tool-tree activity relay
// ============================================================================

// Trimmed ActivitySnapshot per pi-tool-tree's API.md — everything a remote
// client needs, nothing renderer-specific.
interface ActivityTrimmed {
	available: true;
	phase: string;
	isWorking: boolean;
	isThinking: boolean;
	isRunningTool: boolean;
	label: string | null;
	labelElapsedMs: number;
	labelCalls: number;
	thinkingElapsedMs: number;
	calls: Array<{ toolCallId: string; toolName: string; label: string; elapsedMs: number; argPreview?: string }>;
	run: Record<string, unknown>;
}

function trimmedActivity(activity: Record<string, unknown> | undefined): ActivityTrimmed {
	const a = activity ?? {};
	return {
		available: true,
		phase: (a.phase as string) ?? "idle",
		isWorking: Boolean(a.isWorking),
		isThinking: Boolean(a.isThinking),
		isRunningTool: Boolean(a.isRunningTool),
		label: (a.label as string | null) ?? null,
		labelElapsedMs: (a.labelElapsedMs as number) ?? 0,
		labelCalls: (a.labelCalls as number) ?? 0,
		thinkingElapsedMs: (a.thinkingElapsedMs as number) ?? 0,
		calls: Array.isArray(a.calls)
			? (a.calls as Array<Record<string, unknown>>).map((call) => ({
					toolCallId: call.toolCallId as string,
					toolName: call.toolName as string,
					label: (call.label as string | null) ?? "",
					elapsedMs: (call.elapsedMs as number) ?? 0,
					argPreview: (call.argPreview as string | undefined) ?? undefined,
				}))
			: [],
		run: (a.run as Record<string, unknown>) ?? {},
	};
}

function toolTreeApi(): {
	getActivity?: () => Record<string, unknown>;
	getStats?: () => Record<string, unknown>;
	subscribe?: (listener: (activity: Record<string, unknown>, change: Record<string, unknown>) => void) => () => void;
} | null {
	const api = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-tool-tree:api")];
	return api && typeof api === "object" ? (api as never) : null;
}

// ============================================================================
// Server state
// ============================================================================

interface Subscription {
	socket: net.Socket;
	events: Set<string>;
	subscriptionId: string;
}

interface SocketState {
	server: net.Server | null;
	socketPath: string | null;
	context: ExtensionContext | null;
	subscriptions: Subscription[];
	agentStartedAt: number | null;
	/** unsubscribe fn for the pi-tool-tree activity relay (per bound session) */
	activityUnsubscribe: (() => void) | null;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

async function removeSocket(socketPath: string | null): Promise<void> {
	if (!socketPath) return;
	try {
		await fs.unlink(socketPath);
	} catch (error) {
		if (isErrnoException(error) && error.code !== "ENOENT") {
			throw error;
		}
	}
}

// ============================================================================
// Message extraction
// ============================================================================

interface ExtractedMessage {
	role: "user" | "assistant";
	content: string;
	timestamp: number;
}

function getLastAssistantMessage(ctx: ExtensionContext): ExtractedMessage | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message") {
			const msg = entry.message;
			if ("role" in msg && msg.role === "assistant") {
				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				if (textParts.length > 0) {
					return {
						role: "assistant",
						content: textParts.join("\n"),
						timestamp: msg.timestamp,
					};
				}
			}
		}
	}
	return undefined;
}

// ============================================================================
// Command handling
// ============================================================================

function writeResponse(socket: net.Socket, response: RpcResponse): void {
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// Socket may be closed
	}
}

function writeEvent(socket: net.Socket, event: RpcEvent): void {
	try {
		socket.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Socket may be closed
	}
}

function parseCommand(line: string): { command?: RpcCommand; error?: string } {
	try {
		const parsed = JSON.parse(line) as RpcCommand;
		if (!parsed || typeof parsed !== "object") {
			return { error: "Invalid command" };
		}
		if (typeof parsed.type !== "string") {
			return { error: "Missing command type" };
		}
		return { command: parsed };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Failed to parse command" };
	}
}

async function handleCommand(
	state: SocketState,
	command: RpcCommand,
	socket: net.Socket,
): Promise<void> {
	const id = "id" in command && typeof command.id === "string" ? command.id : undefined;
	const respond = (success: boolean, commandName: string, data?: unknown, error?: string) => {
		writeResponse(socket, { type: "response", command: commandName, success, data, error, id });
	};

	const ctx = state.context;
	if (!ctx) {
		respond(false, command.type, undefined, "Session not ready");
		return;
	}

	if (command.type === "abort") {
		ctx.abort();
		respond(true, "abort");
		return;
	}

	if (command.type === "get_state") {
		const model = ctx.model;
		let context: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;
		try {
			const usage = (ctx as unknown as { getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined })
				.getContextUsage?.();
			if (usage) {
				context = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
			}
		} catch {
			// context readout is best-effort
		}
		respond(true, "get_state", {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			context,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: ctx.thinkingLevel,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
		});
		return;
	}

	if (command.type === "get_message") {
		const message = getLastAssistantMessage(ctx);
		respond(true, "get_message", { message: message ?? null });
		return;
	}

	if (command.type === "get_activity") {
		const api = toolTreeApi();
		if (!api || typeof api.getActivity !== "function") {
			respond(true, "get_activity", { available: false });
			return;
		}
		try {
			const activity = trimmedActivity(api.getActivity() as never);
			const stats = typeof api.getStats === "function" && command.includeStats ? api.getStats() : undefined;
			respond(true, "get_activity", { ...activity, stats });
		} catch (error) {
			respond(false, "get_activity", undefined, error instanceof Error ? error.message : "activity query failed");
		}
		return;
	}

	if (command.type === "subscribe") {
		const requested = Array.isArray(command.events) ? command.events : [];
		const invalid = requested.filter((event) => !SUBSCRIBABLE_EVENTS.has(event));
		if (requested.length === 0 || invalid.length > 0) {
			respond(false, "subscribe", { invalid }, `Events must be a non-empty subset of ${[...SUBSCRIBABLE_EVENTS].join(", ")}`);
			return;
		}
		const subscriptionId =
			id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const subscription: Subscription = {
			socket,
			events: new Set(requested),
			subscriptionId,
		};
		state.subscriptions.push(subscription);
		const cleanup = () => {
			const idx = state.subscriptions.findIndex((s) => s.subscriptionId === subscriptionId);
			if (idx !== -1) state.subscriptions.splice(idx, 1);
		};
		socket.once("close", cleanup);
		socket.once("error", cleanup);
		// Late joiners get a baseline activity snapshot so they do not have to
		// reconstruct state from deltas.
		if (requested.includes("activity_change")) {
			const api = toolTreeApi();
			if (api && typeof api.getActivity === "function") {
				try {
					writeEvent(socket, {
						type: "event",
						event: "activity_change",
						data: { activity: trimmedActivity(api.getActivity() as never), change: { type: "snapshot" } },
					});
				} catch {
					// never fail the subscription over UI plumbing
				}
			}
		}
		respond(true, "subscribe", { subscriptionId, events: requested });
		return;
	}

	if (command.type === "send") {
		const text = typeof command.text === "string" ? command.text : command.message;
		if (typeof text !== "string" || text.trim().length === 0) {
			respond(false, "send", undefined, "Missing text");
			return;
		}

		const mode = command.mode ?? "steer";
		const isIdle = ctx.isIdle();

		try {
			// String content, verbatim from control.ts: convertToLlm handles it and
			// the TUI renders it via the [session-message] custom message renderer.
			const customMessage = {
				customType: "session-message",
				content: text,
				display: true,
			};
			if (isIdle) {
				// Idle: always immediate, regardless of mode.
				pi_sendMessage(customMessage, { triggerTurn: true });
			} else {
				// Streaming: steer (default) lands between tool calls of the current
				// run, follow_up waits for the agent to finish.
				pi_sendMessage(customMessage, {
					triggerTurn: true,
					deliverAs: mode === "follow_up" ? "followUp" : "steer",
				});
			}
			respond(true, "send", { delivered: true, mode: isIdle ? "direct" : mode });
		} catch (error) {
			respond(false, "send", undefined, error instanceof Error ? error.message : "Send failed");
		}
		return;
	}

	// Live rename: pi appends a session_info entry and interactive mode refreshes
	// the terminal title ("π - <name> - <cwd>") on session_info_changed.
	if (command.type === "set_session_name") {
		const name = command.name;
		if (typeof name !== "string" || name.trim().length === 0) {
			respond(false, "set_session_name", undefined, "Missing name");
			return;
		}
		try {
			pi.setSessionName(name.trim());
			respond(true, "set_session_name", { renamed: name.trim() });
		} catch (error) {
			respond(false, "set_session_name", undefined, error instanceof Error ? error.message : "Rename failed");
		}
		return;
	}

	respond(false, (command as { type: string }).type, undefined, `Unsupported command: ${(command as { type: string }).type}`);
}

// sendMessage is captured off the API object because the closure is created
// before pi is in scope inside handleCommand.
let pi_sendMessage: ExtensionAPI["sendMessage"];

// ============================================================================
// Server
// ============================================================================

function createServer(state: SocketState): net.Server {
	return net.createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				newlineIndex = buffer.indexOf("\n");
				if (!line) continue;

				const parsed = parseCommand(line);
				if (parsed.error) {
					writeResponse(socket, {
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${parsed.error}`,
					});
					continue;
				}

				void handleCommand(state, parsed.command!, socket).catch(() => {
					writeResponse(socket, {
						type: "response",
						command: parsed.command!.type,
						success: false,
						error: "Internal handler error",
					});
				});
			}
		});
	});
}

async function startControlServer(pi: ExtensionAPI, state: SocketState, ctx: ExtensionContext): Promise<void> {
	await fs.mkdir(SOCK_DIR, { recursive: true, mode: 0o700 });
	await fs.chmod(SOCK_DIR, 0o700);
	const socketPath = path.join(SOCK_DIR, `${SOCK_NAME_SAFE}${SOCKET_SUFFIX}`);

	if (state.socketPath === socketPath && state.server) {
		state.context = ctx;
		return;
	}

	await stopControlServer(state);
	await removeSocket(socketPath);

	state.context = ctx;
	state.socketPath = socketPath;
	state.server = createServer(state);

	await new Promise<void>((resolve, reject) => {
		state.server!.once("error", reject);
		state.server!.listen(socketPath, () => {
			state.server!.removeListener("error", reject);
			resolve();
		});
	});
	await fs.chmod(socketPath, 0o600);

	if (ctx.hasUI) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `pi-sock: ${socketPath}`));
	}
}

async function stopControlServer(state: SocketState): Promise<void> {
	state.subscriptions = [];
	if (!state.server) {
		await removeSocket(state.socketPath);
		state.socketPath = null;
		return;
	}
	const socketPath = state.socketPath;
	state.socketPath = null;
	await new Promise<void>((resolve) => state.server?.close(() => resolve()));
	state.server = null;
	await removeSocket(socketPath);
}

// The socket file name is fixed at load: PI_SOCK_NAME must be a safe filename.
const SOCK_NAME_SAFE = /^[A-Za-z0-9._-]+$/.test(SOCK_NAME)
	? SOCK_NAME
	: (() => {
			throw new Error(`pi-sock: PI_SOCK_NAME must match [A-Za-z0-9._-]+ (got ${JSON.stringify(SOCK_NAME)})`);
		})();

// ============================================================================
// Extension entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi_sendMessage = (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
		return pi.sendMessage(...args);
	};

	const state: SocketState = {
		server: null,
		socketPath: null,
		context: null,
		subscriptions: [],
		agentStartedAt: null,
		activityUnsubscribe: null,
	};

	const fire = (event: string, data: unknown) => {
		for (const sub of [...state.subscriptions]) {
			if (!sub.events.has(event)) continue;
			writeEvent(sub.socket, { type: "event", event, data });
		}
	};

	/**
	 * Relay pi-tool-tree activity changes to subscribed clients. One persistent
	 * listener per bound session; fire() already gates on current subscribers,
	 * so the cost is one cheap listener regardless of client count.
	 */
	const attachActivityRelay = () => {
		if (state.activityUnsubscribe) {
			try {
				state.activityUnsubscribe();
			} catch {
				// best-effort teardown
			}
			state.activityUnsubscribe = null;
		}
		const api = toolTreeApi();
		if (!api || typeof api.subscribe !== "function" || typeof api.getActivity !== "function") {
			return;
		}
		try {
			state.activityUnsubscribe = api.subscribe((activity, change) => {
				fire("activity_change", {
					activity: trimmedActivity(activity),
					change,
				});
			});
		} catch {
			// pi-tool-tree present but subscription failed — relay stays off
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await startControlServer(pi, state, ctx);
		attachActivityRelay();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (state.activityUnsubscribe) {
			try {
				state.activityUnsubscribe();
			} catch {
				// best-effort teardown
			}
			state.activityUnsubscribe = null;
		}
		if (state.context?.hasUI) {
			state.context.ui.setStatus(STATUS_KEY, undefined);
		}
		await stopControlServer(state);
	});

	pi.on("agent_start", (event: AgentStartEvent, ctx: ExtensionContext) => {
		state.agentStartedAt = Date.now();
		fire("agent_start", {
			timestamp: state.agentStartedAt,
			isIdle: ctx.isIdle(),
		});
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		const lastMessage = getLastAssistantMessage(ctx);
		fire("turn_end", {
			message: lastMessage,
			turnIndex: event.turnIndex,
		});
	});

	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
		const lastMessage = getLastAssistantMessage(ctx);
		const startedAt = state.agentStartedAt;
		state.agentStartedAt = null;
		fire("agent_settled", {
			lastAssistant: lastMessage,
			ranMs: startedAt ? Date.now() - startedAt : null,
			isIdle: ctx.isIdle(),
		});
	});
}
