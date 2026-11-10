#!/usr/bin/env node
/**
 * devctl — 查看 / 关闭开发进程（不限于 uni-app）
 *   node devctl.mjs status [--json] [--project <dir>]
 *   node devctl.mjs stop   [--project <dir>]
 *
 * 不传 --project 时按进程命令行自动推断项目根目录（命令行里出现
 * <root>\node_modules\... 就把 node_modules 之前那段当根），因此不依赖
 * 插件被装在哪、也不依赖项目里有没有这个脚本。
 *
 * 识别规则：
 *   1) 进程命令行 / 可执行文件路径里含项目路径 —— 一定算本项目；
 *   2) 没给项目时：从命令行推断出项目根的也算；
 *   3) 否则看是否像开发服务器（uni / vite / webpack / uvicorn / java -jar / dotnet run …），
 *      且真的在监听端口（>1024）；
 *   4) IDE、编辑器、语言服务器等噪声进程一律排除。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);
const action = args[0] || "status";
const asJson = args.includes("--json");
const projectFlag = (() => {
	const i = args.indexOf("--project");
	return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : "";
})();

const PROJECT = projectFlag || "";
const PROJECT_KEY = PROJECT.toLowerCase().replace(/\\/g, "/");

/** uni-app 平台标识 -> 展示名 */
const PLATFORM_LABEL = {
	"mp-weixin": "小程序",
	"mp-alipay": "支付宝小程序",
	"mp-baidu": "百度小程序",
	"mp-toutiao": "抖音小程序",
	"mp-qq": "QQ 小程序",
	app: "App",
	"app-android": "Android",
	"app-ios": "iOS",
	h5: "H5"
};

/** 进程族 -> 展示名 */
const KIND_LABEL = {
	uni: "uni-app",
	java: "Java",
	python: "Python",
	node: "Node",
	go: "Go",
	dotnet: ".NET",
	php: "PHP",
	nginx: "Nginx",
	ruby: "Ruby",
	rust: "Rust",
	other: ""
};

/** 看起来像开发服务器 / 构建服务的命令行特征 */
const DEV_MARKERS = [
	/\buni\.js\b/,
	/\bvite\b/,
	/\bnext\b/,
	/\bnuxt\b/,
	/\bnest\b/,
	/webpack/,
	/\brollup\b/,
	/\besbuild\b/,
	/\buvicorn\b/,
	/\bgunicorn\b/,
	/\bflask\b/,
	/manage\.py\s+runserver/,
	/\bhypercorn\b/,
	/-jar\s+\S+\.jar/,
	/spring-boot/,
	/\bgo\s+run\b/,
	/\bair\b/,
	/dotnet\s+(run|watch)/,
	/artisan\s+serve/,
	/cargo\s+run/,
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/
];

/** 噪声进程：IDE / 编辑器 / 语言服务器 / 本插件自身 */
const NOISE = [
	/extensionhost/i,
	/language-?server/i,
	/jdt\.ls/i,
	/jetbrains/i,
	/\bidea(64)?\.exe/i,
	/\b(pycharm|webstorm|goland|clion|rider|datagrip)\S*\.exe/i,
	/\bcode\.exe/i,
	/\bcode\s+--/i,
	/msedgewebview/i,
	/devctl\.mjs/i,
	/\.dsh[\\/]/i,
	/eslint/i,
	/typescript[\\/]lib/i
];

const run = (cmd) => {
	try {
		if (Array.isArray(cmd)) {
			return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		}
		return execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
	} catch (err) {
		return (err && err.stdout) || "";
	}
};

/** DSH App 进程的 PATH 里不一定有 System32，裸命令会 ENOENT —— 能定位到就用绝对路径 */
const SYS32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
const POWERSHELL = (() => {
	const candidate = join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(candidate) ? candidate : "powershell";
})();
const NETSTAT = (() => {
	const candidate = join(SYS32, "netstat.exe");
	return existsSync(candidate) ? candidate : "netstat";
})();

/** 可能跑开发服务器的进程名（缩小 CIM 扫描范围） */
const NAME_FILTERS = [
	"node.exe",
	"java.exe",
	"javaw.exe",
	"python.exe",
	"python3.exe",
	"py.exe",
	"go.exe",
	"dotnet.exe",
	"php.exe",
	"nginx.exe",
	"bun.exe",
	"deno.exe",
	"ruby.exe",
	"cargo.exe",
	"air.exe"
];

const DETAIL = 'ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.ExecutablePath)|$($_.CommandLine)" }';

/** 进程详情缓存：CIM 查询约 1s，没必要每 3s 跑一次。
 *  放临时目录：不依赖项目、也不要求项目可写。 */
const CACHE_FILE = join(tmpdir(), "dsh-devctl-cache.json");
const CACHE_TTL = 8000;

const readCache = () => {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		if (!raw || !raw.at || Date.now() - raw.at > CACHE_TTL) return null;
		return raw.procs && typeof raw.procs === "object" ? raw.procs : null;
	} catch {
		return null;
	}
};

const writeCache = (procsObj) => {
	try {
		mkdirSync(dirname(CACHE_FILE), { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), procs: procsObj }), "utf8");
	} catch {
		// 写不进去就算了，下次全量扫描
	}
};

const parseProcs = (text) => {
	const procs = new Map();
	for (const line of String(text || "").split(/\r?\n/)) {
		const raw = line.trim();
		if (!raw) continue;
		const [pidStr, ppidStr, name, exe, ...rest] = raw.split("|");
		const pid = Number(pidStr);
		if (!pid) continue;
		procs.set(pid, {
			ppid: Number(ppidStr) || null,
			name: name || "",
			exe: exe || "",
			cmdline: rest.join("|") || ""
		});
	}
	return procs;
};

/** 端口表：netstat 很快（~60ms），不缓存 */
const listenPorts = () => {
	const ports = new Map();
	const text = run([NETSTAT, "-ano"]);
	for (const line of String(text || "").split(/\r?\n/)) {
		if (!/LISTENING/i.test(line)) continue;
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5) continue;
		const pid = Number(cols[cols.length - 1]);
		const port = Number(String(cols[1]).split(":").pop());
		if (!pid || !port) continue;
		if (!ports.has(pid)) ports.set(pid, []);
		if (!ports.get(pid).includes(port)) ports.get(pid).push(port);
	}
	return ports;
};

const processDetails = () => {
	const cached = readCache();
	if (cached) return parseProcs(Object.values(cached).map((item) => item.raw).join("\n"));
	const nameFilter = NAME_FILTERS.map((item) => `Name='${item}'`).join(" or ");
	const procs = parseProcs(run(`Get-CimInstance Win32_Process -Filter "${nameFilter}" | ${DETAIL}`));
	const store = {};
	for (const [pid, info] of procs) {
		store[pid] = {
			ppid: info.ppid,
			name: info.name,
			exe: info.exe,
			cmdline: info.cmdline,
			raw: `${pid}|${info.ppid || ""}|${info.name}|${info.exe}|${info.cmdline}`
		};
	}
	writeCache(store);
	return procs;
};

const probeSystem = () => ({ ports: listenPorts(), procs: processDetails() });

const buildTree = (procs) => {
	const children = new Map();
	for (const [pid, info] of procs) {
		if (!info.ppid) continue;
		if (!children.has(info.ppid)) children.set(info.ppid, []);
		children.get(info.ppid).push(pid);
	}
	return children;
};

const descendantsOf = (pid, children) => {
	const all = [pid];
	const queue = [pid];
	while (queue.length) {
		const cur = queue.shift();
		for (const child of children.get(cur) || []) {
			if (all.includes(child)) continue;
			all.push(child);
			queue.push(child);
		}
	}
	return all;
};

/** 从命令行 / exe 路径里推断项目根：<root>\node_modules\... → <root> */
const NM = /([A-Za-z]:[\\/][^"'\s]*?)[\\/]node_modules[\\/]/gi;
const inferRoot = (info) => {
	const hay = `${info.exe || ""} ${info.cmdline || ""}`;
	let best = "";
	let m;
	NM.lastIndex = 0;
	while ((m = NM.exec(hay)) !== null) {
		const root = m[1];
		// 取最靠外的那层（npm run dev 会带多层 node_modules）
		if (!best || root.length < best.length) best = root;
	}
	if (best) return best.replace(/[\\/]+$/, "");
	// pnpm 仓库：.../项目/node_modules/.pnpm/... 上面已经覆盖
	return "";
};

const scriptFiles = (cmdline) => String(cmdline || "").match(/[^\s"']+\.(m?js|cjs|ts|py|jar|php|rb)\b/gi) || [];

/** 进程属于哪个项目：返回根目录（可能为空） */
const projectOfProcess = (info) => {
	if (PROJECT_KEY) {
		const hay = `${info.exe || ""} ${info.cmdline || ""}`.toLowerCase().replace(/\\/g, "/");
		if (hay.includes(PROJECT_KEY)) return PROJECT;
		for (const file of scriptFiles(info.cmdline)) {
			const abs = (isAbsolute(file) ? resolve(file) : resolve(PROJECT, file)).replace(/\\/g, "/").toLowerCase();
			if (!abs.startsWith(PROJECT_KEY)) continue;
			if (existsSync(abs)) return PROJECT;
		}
		return "";
	}
	return inferRoot(info);
};

const isNoise = (info) => {
	const hay = `${info.name || ""} ${info.exe || ""} ${info.cmdline || ""}`;
	return NOISE.some((re) => re.test(hay));
};

const looksLikeDevServer = (info) => DEV_MARKERS.some((re) => re.test(info.cmdline || ""));

const kindOf = (info) => {
	const name = String(info.name || "").toLowerCase();
	const cmdline = info.cmdline || "";
	if (/uni\.js/.test(cmdline)) return "uni";
	if (name === "java.exe" || name === "javaw.exe" || name === "java") return "java";
	if (/^python|^py\.exe/.test(name)) return "python";
	if (name === "node.exe" || name === "bun.exe" || name === "deno.exe") return "node";
	if (name === "go.exe") return "go";
	if (name === "dotnet.exe") return "dotnet";
	if (name === "php.exe") return "php";
	if (name === "nginx.exe") return "nginx";
	if (name === "ruby.exe" || name === "rails") return "ruby";
	if (/cargo|rustc/.test(name)) return "rust";
	return "other";
};

const scriptHint = (cmdline) => {
	const jar = cmdline.match(/-jar\s+"?([^"\s]+\.jar)"?/i);
	if (jar) return basename(jar[1]);
	const py = cmdline.match(/([\w.-]+\.py)\b/);
	if (py) return basename(py[1]);
	const vite = cmdline.match(/(?:^|[\\/\s])vite(?:\.js)?\b/);
	if (vite) return "vite";
	const next = cmdline.match(/(?:^|[\\/\s])next(?:\.js)?\b/);
	if (next) return "next";
	const nuxt = cmdline.match(/(?:^|[\\/\s])nuxt\b/);
	if (nuxt) return "nuxt";
	const uniFlag = cmdline.match(/\s-p\s+([\w-]+)/);
	if (uniFlag) return uniFlag[1];
	return "";
};

/** 产物目录：只有真实存在于磁盘才算（H5 dev 走内存编译，没有产物目录） */
const distDirFor = (platform, root) => {
	if (!root) return null;
	for (const candidate of [`dist/dev/${platform}`, `dist/build/${platform}`]) {
		if (existsSync(resolve(root, candidate))) return candidate;
	}
	return null;
};

const pickPort = (pid, ports, children) => {
	const found = [];
	for (const child of descendantsOf(pid, children)) {
		for (const port of ports.get(child) || []) if (!found.includes(port)) found.push(port);
	}
	return found.filter((p) => p > 1024).sort((a, b) => a - b)[0] || null;
};

const findProcesses = () => {
	const { ports, procs } = probeSystem();
	const children = buildTree(procs);
	const selfAndAncestors = new Set();
	let cursor = process.pid;
	let guard = 0;
	while (cursor && guard++ < 32) {
		selfAndAncestors.add(cursor);
		const info = procs.get(cursor);
		cursor = info ? info.ppid : null;
	}

	const candidates = [];
	for (const [pid, info] of procs) {
		if (selfAndAncestors.has(pid)) continue;
		if (isNoise(info)) continue;
		const kind = kindOf(info);
		const root = projectOfProcess(info);
		const port = pickPort(pid, ports, children);
		const dev = looksLikeDevServer(info);
		const isUni = /uni\.js/.test(info.cmdline || "");
		if (root) {
			// 已定位到项目：必须有端口（uni 产物模式除外）
			if (!port && kind !== "uni") continue;
		} else if (!isUni && !(dev && port)) {
			continue;
		}
		candidates.push({ pid, info, kind, root, port, dev });
	}

	// 同一进程链只保留最上层（npm run dev -> node uni.js -> vite 只报一条）
	const qualified = new Set(candidates.map((item) => item.pid));
	const isChainHead = (pid) => {
		let cursor2 = procs.get(pid)?.ppid;
		let guardCount = 0;
		while (cursor2 && guardCount++ < 32) {
			if (qualified.has(cursor2)) return false;
			const info = procs.get(cursor2);
			cursor2 = info ? info.ppid : null;
		}
		return true;
	};

	const list = [];
	for (const item of candidates) {
		if (!isChainHead(item.pid)) continue;
		const { pid, info, kind, root, port } = item;
		const uniMatch = (info.cmdline || "").match(/\s-p\s+([\w-]+)/);
		const platform = kind === "uni" ? (uniMatch ? uniMatch[1] : "h5") : kind;
		const base = kind === "uni" ? PLATFORM_LABEL[platform] || platform : KIND_LABEL[kind] || info.name;
		const hint = kind === "uni" ? "" : scriptHint(info.cmdline || "");
		const label = hint ? `${base} · ${hint}` : base;
		list.push({
			pid,
			ppid: info.ppid,
			kind: kind === "uni" ? "uni" : "other",
			platform,
			label,
			port,
			url: port ? (platform === "h5" ? `http://127.0.0.1:${port}/index.html` : `http://127.0.0.1:${port}`) : "",
			distPath: kind === "uni" ? distDirFor(platform, root) : null,
			project: Boolean(root),
			projectRoot: root || "",
			cmdline: String(info.cmdline || "").slice(0, 300)
		});
	}
	list.sort(
		(a, b) =>
			Number(b.kind === "uni") - Number(a.kind === "uni") ||
			Number(Boolean(b.port)) - Number(Boolean(a.port)) ||
			a.pid - b.pid
	);
	return list;
};

const buildState = () => {
	const procs = findProcesses();
	// 没显式给项目时，用结果里最常见的根目录作为项目
	const roots = procs.map((p) => p.projectRoot).filter(Boolean);
	const counts = new Map();
	for (const r of roots) counts.set(r, (counts.get(r) || 0) + 1);
	const inferred = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
	const project = PROJECT || inferred || process.cwd();
	return {
		project,
		inferred: !PROJECT && Boolean(inferred),
		running: procs.length > 0,
		procs,
		hasDistDev: existsSync(resolve(project, "dist/dev")),
		hasDistBuild: existsSync(resolve(project, "dist/build")),
		checkedAt: new Date().toISOString()
	};
};

const killTree = (pid) => {
	run(`taskkill /PID ${pid} /T /F`);
};

if (action === "status") {
	const state = buildState();
	if (asJson) {
		process.stdout.write(JSON.stringify(state, null, 2) + "\n");
	} else if (!state.running) {
		console.log("没有在运行的开发进程（dev 已停止）");
	} else {
		for (const p of state.procs) {
			const where = p.url || (p.distPath ? `产物目录 ${p.distPath}` : "内存编译（无产物目录）");
			console.log(`${p.label} · PID ${p.pid} · ${where}`);
		}
	}
} else if (action === "stop") {
	const state = buildState();
	if (!state.running) {
		console.log("没有在运行的开发进程，无需关闭");
	} else {
		for (const p of state.procs) {
			killTree(p.pid);
			console.log(`已关闭 ${p.label} 进程（PID ${p.pid}）`);
		}
	}
} else {
	console.error("用法: node devctl.mjs [status|stop] [--json] [--project <dir>]");
	process.exit(1);
}
