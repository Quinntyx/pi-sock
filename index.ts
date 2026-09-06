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
	id?: string;
}

interface RpcAbortCommand {
	type: "abort";
	id?: string;
}

type RpcCommand =
	| RpcSendCommand
	| RpcGetStateCommand
	| RpcGetMessageCommand
	| RpcSubscribeCommand
	| RpcAbortCommand;

const SUBSCRIBABLE_EVENTS = new Set(["agent_start", "turn_end", "agent_settled"]);

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
		respond(true, "get_state", {
			isIdle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
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
			if (isIdle) {
				// Idle: always immediate, regardless of mode.
				pi_sendUserMessage(state, text);
			} else {
				// Streaming: deliverAs is required; steer (default) lands between tool
				// calls of the current run, follow_up waits for the agent to finish.
				pi_sendUserMessage(state, text, mode === "follow_up" ? "followUp" : "steer");
			}
			respond(true, "send", { delivered: true, mode: isIdle ? "direct" : mode });
		} catch (error) {
			respond(false, "send", undefined, error instanceof Error ? error.message : "Send failed");
		}
		return;
	}

	respond(false, command.type, undefined, `Unsupported command: ${command.type}`);
}

// sendUserMessage is captured off the API object because the closure is created
// before pi is in scope inside handleCommand.
let pi_sendUserMessage: ExtensionAPI["sendUserMessage"];

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
	pi_sendUserMessage = (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
		return pi.sendUserMessage(...args);
	};

	const state: SocketState = {
		server: null,
		socketPath: null,
		context: null,
		subscriptions: [],
		agentStartedAt: null,
	};

	const fire = (event: string, data: unknown) => {
		for (const sub of [...state.subscriptions]) {
			if (!sub.events.has(event)) continue;
			writeEvent(sub.socket, { type: "event", event, data });
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		await startControlServer(pi, state, ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
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
