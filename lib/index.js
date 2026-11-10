/**
 * dsh-devproc — 宿主半体
 *
 * GET  /api/devproc/status   当前快照（走缓存，毫秒级返回）
 * GET  /api/devproc/stream   SSE 推送（变化即下发，15s 心跳）
 * GET  /api/devproc/config   读取设置
 * POST /api/devproc/config   保存设置（热生效）
 * POST /api/devproc/stop     关闭进程（带 {pid} 只关一条）
 * POST /api/devproc/open     打开浏览器 / 打开产物目录
 * GET  /api/devproc/agent    当前「正在修改 / 已改好」状态
 * POST /api/devproc/agent    代理上报状态 {state:"editing"|"done"|"idle", note?, files?}
 *
 * 设计要点：
 *  - 全局只有一个后台采样器，开几个窗口都只跑一份 PowerShell；无订阅且 60s 无人查询则自动停采；
 *  - URL 用真实 HTTP 探测（/ 优先，/index.html 兜底），结果缓存 60s；
 *  - 进程探测复用项目里的 scripts/devctl.mjs，避免逻辑分叉。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, readdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import http from "node:http";

const execFileAsync = promisify(execFile);

export const name = "devproc";
export const inject = ["webServer"];

const DEFAULT_PROJECT = "C:\\jobCode\\munich-mini";
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const CONFIG_FILE = join(DSH_HOME, "dsh-devproc.config.json");
const PROBE_TTL = 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const IDLE_STOP_MS = 60 * 1000;

const DEFAULT_CONFIG = {
	project: "",
	pollMs: 3000,
	showPlatforms: [],
	probeUrls: true,
	// 微信开发者工具 cli.bat 路径；留空则自动探测常见安装位置
	wechatCli: ""
};

/** 微信开发者工具 cli.bat 候选位置（含本机实测路径） */
const WECHAT_CLI_CANDIDATES = [
	"C:\\软件\\微信web开发者工具\\cli.bat",
	"C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat",
	"C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat",
	"C:\\Program Files (x86)\\Tencent\\微信开发者工具\\cli.bat",
	"C:\\Program Files\\Tencent\\微信开发者工具\\cli.bat"
];

/** 找到可用的 cli.bat：配置优先，其次候选列表 */
const findWechatCli = () => {
	const configured = (state.config && state.config.wechatCli) || "";
	if (configured && existsSync(configured)) return configured;
	for (const candidate of WECHAT_CLI_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
};

/* ------------------------------------------------------------------ 配置 */

const loadConfig = () => {
	try {
		if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
		const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		return { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

const persistConfig = (next) => {
	try {
		mkdirSync(dirname(CONFIG_FILE), { recursive: true });
		writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
};

/* ------------------------------------------------------------------ 工具 */

const writeJson = (res, code, body) => {
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.writeHead(code);
	res.end(JSON.stringify(body));
};

const readBody = (req) =>
	new Promise((resolve) => {
		let buffer = "";
		req.on("data", (chunk) => {
			if (buffer.length < 64 * 1024) buffer += chunk;
		});
		req.on("end", () => resolve(buffer));
		req.on("error", () => resolve(""));
	});

const parseJsonTail = (out) => {
	const start = out.indexOf("{");
	if (start < 0) return null;
	try {
		return JSON.parse(out.slice(start));
	} catch {
		return null;
	}
};

const runDevctl = async (project, args) => {
	const script = join(project, "scripts", "devctl.mjs");
	const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
		cwd: project,
		windowsHide: true,
		timeout: 25000,
		maxBuffer: 4 * 1024 * 1024
	});
	return stdout || "";
};

const killTree = async (pid) => {
	await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => null);
};

/* ------------------------------------------------------- 真实 HTTP 探测 */

const probeCache = new Map();

const httpOk = (url) =>
	new Promise((resolve) => {
		let settled = false;
		const done = (ok) => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		const req = http.get(url, { timeout: 1500 }, (res) => {
			res.resume();
			done(Boolean(res.statusCode) && res.statusCode < 400);
		});
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
	});

/** 端口 -> 真正能打开的 URL（/ 优先，/index.html 兜底），带缓存 */
const probePort = async (port, fallback) => {
	const cached = probeCache.get(port);
	if (cached && Date.now() - cached.at < PROBE_TTL) return cached.url;
	const base = "http://127.0.0.1:" + port;
	const candidates = [base + "/", base + "/index.html"];
	for (const url of candidates) {
		// eslint-disable-next-line no-await-in-loop
		if (await httpOk(url)) {
			probeCache.set(port, { url, at: Date.now() });
			return url;
		}
	}
	const url = fallback || candidates[0];
	probeCache.set(port, { url, at: Date.now() });
	return url;
};

/* ------------------------------------------------------------------ 采样 */

const state = {
	config: loadConfig(),
	snapshot: null,
	snapshotAt: 0,
	lastText: "",
	clients: new Set(),
	timer: null,
	timerInterval: 0,
	inFlight: null,
	lastDemand: 0
};

const projectOf = () => state.config.project || process.env.DSH_DEVPROC_PROJECT || DEFAULT_PROJECT;

const broadcast = (event, data) => {
	const payload = "event: " + event + "\ndata: " + data + "\n\n";
	for (const client of state.clients) {
		try {
			client.write(payload);
		} catch {
			state.clients.delete(client);
		}
	}
};

const sampleOnce = async () => {
	if (state.inFlight) return state.inFlight;

	state.inFlight = (async () => {
		const project = projectOf();
		let snap;
		try {
			const out = await runDevctl(project, ["status", "--json"]);
			snap = parseJsonTail(out) || { project, running: false, procs: [] };
		} catch (err) {
			snap = { project, running: false, procs: [], error: String((err && err.message) || err) };
		}
		snap.project = snap.project || project;

		let procs = Array.isArray(snap.procs) ? snap.procs : [];
		const show = Array.isArray(state.config.showPlatforms) ? state.config.showPlatforms : [];
		// 平台筛选只作用于 uni-app 那几种；后端/其他进程始终显示
		if (show.length > 0) procs = procs.filter((proc) => proc.kind === "other" || show.includes(proc.platform));

		if (state.config.probeUrls !== false) {
			for (const proc of procs) {
				if (!proc.port) continue;
				// eslint-disable-next-line no-await-in-loop
				proc.url = await probePort(proc.port, proc.url);
			}
		}

		snap.procs = procs;
		snap.running = procs.length > 0;
		snap.agent = agentPublic();
		snap.config = { pollMs: state.config.pollMs, project: state.config.project || "" };
		snap.checkedAt = new Date().toISOString();

		const text = JSON.stringify(snap);
		state.snapshot = snap;
		state.snapshotAt = Date.now();
		if (text !== state.lastText) {
			state.lastText = text;
			broadcast("status", text);
		}
		return snap;
	})();

	try {
		return await state.inFlight;
	} finally {
		state.inFlight = null;
	}
};

const tick = () => {
	if (state.clients.size === 0 && Date.now() - state.lastDemand > IDLE_STOP_MS) {
		stopSampler();
		return;
	}
	sampleOnce().catch(() => null);
};

const startSampler = () => {
	const interval = Math.max(1000, Number(state.config.pollMs) || 3000);
	if (state.timer && state.timerInterval === interval) return;
	if (state.timer) clearInterval(state.timer);
	state.timerInterval = interval;
	state.timer = setInterval(tick, interval);
	if (typeof state.timer.unref === "function") state.timer.unref();
	tick();
};

const stopSampler = () => {
	if (!state.timer) return;
	clearInterval(state.timer);
	state.timer = null;
	state.timerInterval = 0;
};

const kick = () => {
	state.lastDemand = Date.now();
	startSampler();
};

/* --------------------------------------------- 代理（Agent）改动状态标记 */

/**
 * 胶囊上的「正在修改 / 已改好」。
 *  - 自动：fs.watch 盯项目 src（没有 src 就盯项目根），有改动即 editing，静默 2.5s 后 done；
 *  - 手动：POST /api/devproc/agent {state:"editing"|"done"|"idle", note?, files?}
 */
const AGENT_QUIET_MS = 2500;
const AGENT_HOLD_MS = 3 * 60 * 1000;
const AGENT_MANUAL_MS = 5 * 60 * 1000;
const IGNORE_PATH = /(^|\/)(node_modules|\.git|dist|\.cache|unpackage|tmp)(\/|$)/i;

const agent = {
	state: "idle",
	note: "",
	files: [],
	changed: 0,
	at: 0,
	burst: false,
	watcher: null,
	watchedRoot: "",
	quietTimer: null,
	holdTimer: null
};

/** 只把纯数据塞进快照，timer / watcher 不能序列化 */
const agentPublic = () => ({
	state: agent.state,
	note: agent.note,
	files: agent.files.slice(0, 6),
	changed: agent.changed,
	at: agent.at
});

const clearAgentTimer = (key) => {
	if (!agent[key]) return;
	clearTimeout(agent[key]);
	agent[key] = null;
};

const refreshAgent = () => {
	kick();
	state.lastText = "";
	sampleOnce().catch(() => null);
};

const scheduleAgentHold = () => {
	clearAgentTimer("holdTimer");
	agent.holdTimer = setTimeout(() => {
		agent.holdTimer = null;
		agent.state = "idle";
		agent.note = "";
		agent.files = [];
		agent.changed = 0;
		agent.at = Date.now();
		refreshAgent();
	}, AGENT_HOLD_MS);
	if (agent.holdTimer.unref) agent.holdTimer.unref();
};

const markEditing = (rel) => {
	if (!agent.burst) {
		agent.burst = true;
		agent.changed = 0;
		agent.files = [];
	}
	agent.changed += 1;
	if (rel && !agent.files.includes(rel)) agent.files = [rel, ...agent.files].slice(0, 6);
	agent.state = "editing";
	agent.note = "";
	agent.at = Date.now();
	clearAgentTimer("holdTimer");
	clearAgentTimer("quietTimer");
	agent.quietTimer = setTimeout(() => {
		agent.quietTimer = null;
		agent.state = "done";
		agent.burst = false;
		agent.at = Date.now();
		scheduleAgentHold();
		refreshAgent();
	}, AGENT_QUIET_MS);
	if (agent.quietTimer.unref) agent.quietTimer.unref();
	refreshAgent();
};

const stopAgentWatcher = () => {
	if (agent.watcher) {
		try {
			agent.watcher.close();
		} catch {
			/* 忽略 */
		}
		agent.watcher = null;
	}
	agent.watchedRoot = "";
};

const startAgentWatcher = () => {
	const project = projectOf();
	if (!existsSync(project)) return;
	const root = existsSync(join(project, "src")) ? join(project, "src") : project;
	if (agent.watcher && agent.watchedRoot === root) return;
	stopAgentWatcher();
	try {
		const watcher = watch(root, { recursive: true }, (event, filename) => {
			const rel = String(filename || "").replace(/\\/g, "/");
			if (!rel || IGNORE_PATH.test(rel)) return;
			markEditing(rel);
		});
		watcher.on("error", () => stopAgentWatcher());
		if (watcher.unref) watcher.unref();
		agent.watcher = watcher;
		agent.watchedRoot = root;
	} catch {
		agent.watcher = null;
	}
};

const setAgent = (patch) => {
	const next = String((patch && patch.state) || "").toLowerCase();
	const note = patch && typeof patch.note === "string" ? patch.note : null;
	const files = Array.isArray(patch && patch.files) ? patch.files.filter((f) => typeof f === "string").slice(0, 6) : null;
	const autoDone = () => {
		agent.quietTimer = null;
		agent.state = "done";
		agent.burst = false;
		agent.at = Date.now();
		scheduleAgentHold();
		refreshAgent();
	};

	if (next === "editing") {
		clearAgentTimer("quietTimer");
		clearAgentTimer("holdTimer");
		agent.state = "editing";
		agent.burst = true;
		if (note !== null) agent.note = note;
		if (files) agent.files = files;
		agent.at = Date.now();
		// 代理长时间不上报就自己收尾，别永久挂着「正在修改」
		agent.quietTimer = setTimeout(autoDone, AGENT_MANUAL_MS);
		if (agent.quietTimer.unref) agent.quietTimer.unref();
		refreshAgent();
		return agentPublic();
	}
	if (next === "done") {
		clearAgentTimer("quietTimer");
		agent.state = "done";
		agent.burst = false;
		if (note !== null) agent.note = note;
		if (files) agent.files = files;
		agent.at = Date.now();
		scheduleAgentHold();
		refreshAgent();
		return agentPublic();
	}
	clearAgentTimer("quietTimer");
	clearAgentTimer("holdTimer");
	agent.state = "idle";
	agent.burst = false;
	agent.note = "";
	agent.files = [];
	agent.changed = 0;
	agent.at = Date.now();
	refreshAgent();
	return agentPublic();
};

/* ------------------------------------------------------------ 打开目标 */

/**
 * 拉起外部程序。
 * 注意：不能带 windowsHide —— 那会给子进程设 SW_HIDE，explorer/start 会照做，
 * 结果就是「点了没反应」。这里用 detached + stdio:ignore，彻底脱离 DSH 进程树。
 */
const launch = (cmd, args, options) =>
	new Promise((resolve) => {
		let child;
		try {
			child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false, ...(options || {}) });
		} catch {
			resolve(false);
			return;
		}
		let done = false;
		const finish = (ok) => {
			if (done) return;
			done = true;
			resolve(ok);
		};
		child.on("error", () => finish(false));
		child.unref();
		setTimeout(() => finish(true), 400);
	});

/** 微信开发者工具是否已在运行 */
const isWechatRunning = async () => {
	try {
		// 用绝对路径：App 进程的 PATH 里不一定有 System32，裸 tasklist 会 ENOENT
		const tasklist = join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
		const { stdout } = await execFileAsync(tasklist, ["/fi", "imagename eq wechatdevtools.exe", "/nh"], {
			windowsHide: true
		});
		return /wechatdevtools/i.test(String(stdout || ""));
	} catch {
		return false;
	}
};

/* -------------------------------- 微信开发者工具服务端口
 * CLI 只有在「设置 → 安全设置 → 服务端口」开启时才能切项目，否则它会卡在
 * 「Enable IDE Service (y/N)」上等输入（旧代码 fire-and-forget，看起来就像没反应，
 * IDE 于是继续恢复上次打开的项目）。这里改成：优先走服务端口的 HTTP 接口，
 * 退而跑 CLI 并把 y 喂进去，最后把「服务端口没开」如实回报给胶囊。
 */

/** <User Data>/<hash>/Default —— CLI 的 .ide / .ide-status 就放在这里 */
const wechatStateDir = () => {
	const root = join(process.env.LOCALAPPDATA || "", "微信开发者工具", "User Data");
	let fallback = null;
	try {
		for (const entry of readdirSync(root)) {
			const dir = join(root, entry, "Default");
			if (!existsSync(dir)) continue;
			// 优先挑服务端口已开、端口号有效的那一份（可能残留多个用户数据目录）
			if (readSmall(join(dir, ".ide-status")) === "On" && Number(readSmall(join(dir, ".ide"))) > 0) return dir;
			if (!fallback) fallback = dir;
		}
	} catch {
		/* 没装或没权限 */
	}
	return fallback;
};

const readSmall = (file) => {
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "";
	}
};

/** 服务端口：.ide-status 为 On 且 .ide 有端口号时才算就绪 */
const wechatIdePort = () => {
	const dir = wechatStateDir();
	if (!dir) return 0;
	if (readSmall(join(dir, ".ide-status")) !== "On") return 0;
	const port = Number(readSmall(join(dir, ".ide")));
	return Number.isFinite(port) && port > 0 ? port : 0;
};

/** GET /open?projectpath=<dir> —— IDE 服务端口的原生切项目接口 */
const wechatRestOpen = (port, projectPath, timeoutMs = 1500) =>
	new Promise((resolve) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path: `/open?projectpath=${encodeURIComponent(projectPath)}`,
				method: "GET",
				timeout: timeoutMs
			},
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			}
		);
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.on("error", () => resolve(false));
		req.end();
	});

/**
 * 跑 cli.bat 等价的命令：直接起 cli 目录下的 node.exe + cli.js。
 * 走 cmd /c 时 Node 的引号转义会把带空格的整串当成一个命令名，实测报
 * 「'"...\cli.bat"' 不是内部或外部命令」——这正是之前「点了微没反应」的原因。
 * 预先喂一个 y，免得卡在「Enable IDE Service (y/N)」提示上。
 */
const runWechatCli = (cli, args, cwd, timeoutMs = 25000) =>
	new Promise((resolve) => {
		const dir = dirname(cli);
		const nodeExe = join(dir, "node.exe");
		const cliJs = join(dir, "cli.js");
		const useNode = existsSync(nodeExe) && existsSync(cliJs);
		let child;
		try {
			child = useNode
				? spawn(nodeExe, [cliJs, ...args], {
						cwd,
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"]
					})
				: spawn(cli, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], shell: true });
		} catch (err) {
			resolve({ ok: false, output: String((err && err.message) || err) });
			return;
		}
		let output = "";
		let done = false;
		const push = (chunk) => {
			output = (output + String(chunk)).slice(-8000);
		};
		child.stdout?.on("data", push);
		child.stderr?.on("data", push);
		try {
			child.stdin.write("y\n");
		} catch {
			/* 忽略 */
		}
		const finish = (payload) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ...payload, output });
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* 忽略 */
			}
			finish({ ok: false, timedOut: true });
		}, timeoutMs);
		child.on("error", () => finish({ ok: false, error: "spawn failed" }));
		child.on("close", (code) => finish({ ok: code === 0, code }));
	});

/** 用微信开发者工具打开项目目录 */
const openWechatDevtools = async (target) => {
	const cli = findWechatCli();
	if (!cli) throw new Error("没找到微信开发者工具 cli.bat，可在设置里填写路径");
	const projectDir = projectOf();
	const abs = target ? (isAbsolute(target) ? target : join(projectDir, target)) : "";
	let used = abs;
	let fallback = false;
	if (!used || !existsSync(used)) {
		used = projectDir;
		fallback = Boolean(abs);
	}
	// IDE 没启动时 cli 会长时间阻塞等进程起来，所以先自己把 GUI 拉起来。
	// 进程表在某些沙箱里看不到，服务端口已开也算「已在运行」。
	const running = (await isWechatRunning()) || wechatIdePort() > 0;
	let started = false;
	if (!running) {
		const exe = cli.replace(/cli\.bat$/i, "微信开发者工具.exe");
		if (existsSync(exe)) started = await launch(exe, [], { cwd: projectDir });
		if (started) {
			// 等它就绪（最多 20s），比固定 sleep 4s 稳也快
			for (let i = 0; i < 40 && !wechatIdePort(); i += 1) await new Promise((done) => setTimeout(done, 500));
		}
	}
	const port = wechatIdePort();
	if (port && (await wechatRestOpen(port, used))) {
		return { cli, project: used, fallback, started, method: "rest" };
	}
	const result = await runWechatCli(cli, ["open", "--project", used], projectDir);
	if (result.ok) return { cli, project: used, fallback, started, method: "cli" };
	const disabled = /service port disabled|wait IDE port timeout|服务端口已关闭/i.test(result.output || "");
	return {
		cli,
		project: used,
		fallback,
		started,
		ok: false,
		needsServicePort: disabled,
		hint: disabled
			? "服务端口没开：微信开发者工具 → 设置 → 安全设置 → 服务端口 → 开启（只需开一次）"
			: "命令行没能切到当前项目，先把「服务端口」打开再试",
		output: result.output
	};
};

const openTarget = async (target) => {
	if (/^https?:\/\//i.test(target)) {
		let ok = await launch("cmd", ["/c", "start", "", target]);
		if (!ok) ok = await launch("rundll32", ["url.dll,FileProtocolHandler", target]);
		if (!ok) throw new Error("无法打开浏览器");
		return { kind: "url", opened: target, fallback: false };
	}
	const project = projectOf().replace(/\//g, "\\").replace(/\\$/, "");
	const normalized = target.replace(/\//g, "\\");
	if (!normalized.toLowerCase().startsWith(project.toLowerCase())) {
		throw new Error("只允许打开项目目录下的路径");
	}
	// 路径不存在（例如 H5 dev 走内存编译，没有 dist/dev/h5）时退到项目根目录，别让 explorer 打开「此电脑」
	let used = normalized;
	let fallback = false;
	if (!existsSync(used)) {
		used = project;
		fallback = true;
	}
	await launch("cmd", ["/c", "start", "", used]);
	return { kind: "dir", opened: used, fallback };
};

/* ------------------------------------------------------------------ 路由 */

export function apply(ctx, config) {
	void config;

	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;

		const routes = [
			{
				kind: "exact",
				path: "/api/devproc/status",
				handler: async (req, res) => {
					kick();
					if (state.snapshot && Date.now() - state.snapshotAt < 2000) {
						writeJson(res, 200, { ok: true, ...state.snapshot });
						return;
					}
					try {
						writeJson(res, 200, { ok: true, ...(await sampleOnce()) });
					} catch (err) {
						writeJson(res, 200, {
							ok: false,
							running: false,
							procs: [],
							project: projectOf(),
							error: String((err && err.message) || err)
						});
					}
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/stream",
				handler: (req, res) => {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no"
					});
					res.write("retry: 3000\n\n");
					state.clients.add(res);
					kick();

					if (state.snapshot) {
						res.write("event: status\ndata: " + JSON.stringify(state.snapshot) + "\n\n");
					} else {
						sampleOnce().catch(() => null);
					}

					const heartbeat = setInterval(() => {
						try {
							res.write(": ping " + Date.now() + "\n\n");
						} catch {
							/* 连接已断开 */
						}
					}, HEARTBEAT_MS);

					const cleanup = () => {
						clearInterval(heartbeat);
						state.clients.delete(res);
					};
					req.on("close", cleanup);
					req.on("error", cleanup);
					res.on("close", cleanup);
					res.on("error", cleanup);
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/config",
				handler: async (req, res) => {
					if ((req.method || "GET").toUpperCase() === "GET") {
						writeJson(res, 200, { ok: true, config: state.config, file: CONFIG_FILE, project: projectOf() });
						return;
					}
					try {
						const raw = await readBody(req);
						const patch = raw ? JSON.parse(raw) : {};
						const next = { ...state.config };
						if (patch && typeof patch === "object") {
							if (typeof patch.pollMs === "number") next.pollMs = Math.min(60000, Math.max(1000, Math.round(patch.pollMs)));
							if (typeof patch.project === "string") next.project = patch.project.trim();
							if (Array.isArray(patch.showPlatforms)) next.showPlatforms = patch.showPlatforms.filter((item) => typeof item === "string");
							if (typeof patch.probeUrls === "boolean") next.probeUrls = patch.probeUrls;
							if (typeof patch.wechatCli === "string") next.wechatCli = patch.wechatCli.trim();
						}
						state.config = next;
						const saved = persistConfig(next);
						probeCache.clear();
						state.lastText = "";
						stopSampler();
						stopAgentWatcher();
						startAgentWatcher();
						kick();
						sampleOnce().catch(() => null);
						writeJson(res, 200, { ok: true, saved, config: state.config });
					} catch (err) {
						writeJson(res, 400, { ok: false, error: String((err && err.message) || err) });
					}
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/stop",
				handler: async (req, res) => {
					try {
						const raw = await readBody(req);
						let pid = 0;
						try {
							const parsed = raw ? JSON.parse(raw) : null;
							pid = Number(parsed && parsed.pid) || 0;
						} catch {
							pid = 0;
						}
						if (pid) {
							await killTree(pid);
							writeJson(res, 200, { ok: true, pid, output: "已关闭 PID " + pid });
						} else {
							const out = await runDevctl(projectOf(), ["stop"]);
							writeJson(res, 200, { ok: true, output: String(out).trim() });
						}
						setTimeout(() => sampleOnce().catch(() => null), 800);
					} catch (err) {
						writeJson(res, 500, { ok: false, error: String((err && err.message) || err) });
					}
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/open",
				handler: async (req, res) => {
					try {
						const raw = await readBody(req);
						const parsed = raw ? JSON.parse(raw) : {};
						const target = String((parsed && parsed.target) || "").trim();
						if (!target) {
							writeJson(res, 400, { ok: false, error: "缺少 target" });
							return;
						}
						const result = await openTarget(target);
						writeJson(res, 200, { ok: true, ...result });
					} catch (err) {
						writeJson(res, 500, { ok: false, error: String((err && err.message) || err) });
					}
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/wechat",
				handler: async (req, res) => {
					try {
						const raw = await readBody(req);
						const parsed = raw ? JSON.parse(raw) : {};
						let target = String((parsed && parsed.target) || "").trim();
						if (!target) {
							const mp = (state.snapshot?.procs || []).find((proc) => String(proc.platform || "").startsWith("mp"));
							if (mp && mp.distPath) target = mp.distPath;
						}
						const result = await openWechatDevtools(target);
						writeJson(res, 200, { ok: true, ...result });
					} catch (err) {
						writeJson(res, 500, { ok: false, error: String((err && err.message) || err) });
					}
				}
			},
			{
				kind: "exact",
				path: "/api/devproc/agent",
				handler: async (req, res) => {
					if ((req.method || "GET").toUpperCase() === "GET") {
						writeJson(res, 200, { ok: true, agent: agentPublic(), watching: agent.watchedRoot || null });
						return;
					}
					try {
						const raw = await readBody(req);
						const parsed = raw ? JSON.parse(raw) : {};
						writeJson(res, 200, { ok: true, agent: setAgent(parsed) });
					} catch (err) {
						writeJson(res, 400, { ok: false, error: String((err && err.message) || err) });
					}
				}
			}
		];

		const disposers = routes.map((route) => webServer.register(route));

		startAgentWatcher();

		ctx.effect(
			() => () => {
				stopSampler();
				stopAgentWatcher();
				clearAgentTimer("quietTimer");
				clearAgentTimer("holdTimer");
				for (const client of state.clients) {
					try {
						client.end();
					} catch {
						/* 忽略 */
					}
				}
				state.clients.clear();
				state.snapshot = null;
				state.lastText = "";
				probeCache.clear();
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {
						/* 忽略 */
					}
				}
			},
			"devproc: dispose webServer routes"
		);
	});
}
