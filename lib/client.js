/**
 * dsh-devproc — 浏览器半体
 *
 * 1) 输入框上方 dock 区右侧插入进程胶囊（SSE 推送，秒级感知启停）：
 *      ● H5 · 5175   ⧉ ↗ 📁 ✕
 * 2) 设置页新增「终端进程」分区：轮询间隔 / 项目路径 / 平台筛选 / 真实探测开关
 *
 * 稳健性：所有渲染包在 ErrorBoundary 里，挂掉只消失、不污染 slot；
 *        卸载时关闭 EventSource / 停轮询 / 释放槽位。
 */
window.__ModuleLoader__.load({
	id: "dsh-devproc",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useRef, useCallback } = React;

		const API_STATUS = "/api/devproc/status";
		const API_STREAM = "/api/devproc/stream";
		const API_STOP = "/api/devproc/stop";
		const API_OPEN = "/api/devproc/open";
		const API_WECHAT = "/api/devproc/wechat";
		const API_CONFIG = "/api/devproc/config";
		const CSS_ID = "dsh-devproc/chip.css";

		/* ------------------------------------------------------------ 样式 */

		const CSS = [
			".dvp-wrap{display:flex;flex-direction:column;gap:4px;align-items:flex-end;padding:2px 6px 0}",
			".dvp{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:999px;",
			"border:1px solid var(--dsw-alias-border-l2,#80808059);background:var(--dsw-alias-fill-l2,#ffffff0d);",
			"color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:11px;line-height:1;white-space:nowrap;max-width:420px}",
			".dvp__dot{width:6px;height:6px;border-radius:50%;background:#3ce48c;flex:none}",
			".dvp__dot--idle{background:#9a9a9a}",
			".dvp__dot--busy{background:#f5a524;animation:dvp-blink 1.1s ease-in-out infinite}",
			".dvp__dot--done{background:#3ce48c}",
			"@keyframes dvp-blink{50%{opacity:.3}}",
			".dvp__tag{font-size:11px;line-height:1;padding:2px 6px;border-radius:5px;white-space:nowrap;flex:none;",
			"font-weight:500}",
			".dvp__tag--busy{color:#f5a524;background:#f5a52426}",
			".dvp__tag--done{color:#3ce48c;background:#3ce48c26}",
			".dvp__text{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#e8e8e8)}",
			".dvp__btn{display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:18px;padding:0 4px;",
			"border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font:inherit;",
			"font-size:11px;line-height:1;cursor:pointer}",
			".dvp__btn:hover{background:var(--dsw-alias-fill-l3,#ffffff1f);color:var(--dsw-alias-label-primary,#e8e8e8)}",
			".dvp__btn:disabled{opacity:.45;cursor:default}",
			".dvp__btn--danger:hover{color:#ff6b6b}",
			".dvp__sep{width:1px;height:10px;background:var(--dsw-alias-border-l2,#80808059);flex:none}",
			".dvp-set{display:flex;flex-direction:column;gap:14px;padding:16px 4px;font-size:13px;",
			"color:var(--dsw-alias-label-primary,#e8e8e8)}",
			".dvp-set__row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
			".dvp-set__label{min-width:112px;color:var(--dsw-alias-label-secondary,#9a9a9a)}",
			".dvp-set__input{height:28px;padding:0 8px;border-radius:7px;font:inherit;font-size:12px;min-width:260px;",
			"color:var(--dsw-alias-label-primary,#e8e8e8);background:var(--dsw-alias-fill-l2,#ffffff14);",
			"border:1px solid var(--dsw-alias-border-l2,#80808059);outline:none}",
			".dvp-set__input:focus{border-color:var(--dsw-alias-state-business-primary,#4176e6)}",
			".dvp-set__check{display:inline-flex;align-items:center;gap:5px;font-size:12px;",
			"color:var(--dsw-alias-label-secondary,#9a9a9a)}",
			".dvp-set__btn{height:28px;padding:0 14px;border-radius:7px;border:1px solid var(--dsw-alias-state-business-primary,#4176e6);",
			"background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;font:inherit;font-size:12px;cursor:pointer}",
			".dvp-set__btn:disabled{opacity:.5;cursor:default}",
			".dvp-set__hint{font-size:11.5px;color:var(--dsw-alias-label-caption,#8a8a8a)}"
		].join("");

		const injectCss = () => {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-devproc";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		};

		/* -------------------------------------------------- 错误边界（渲染隔离） */

		class ErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				// 只记录，不打断宿主 UI
				console.warn("[dsh-devproc]", error && error.message ? error.message : error);
			}
			render() {
				if (this.state.failed) return null;
				return this.props.children || null;
			}
		}

		const guard = (node) => h(ErrorBoundary, null, node);

		/* ---------------------------------------------------------------- 数据 */

		const postJson = (url, body) =>
			fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {})
			})
				.then((res) => res.json())
				.catch(() => ({ ok: false }));

		const emptyState = { ok: true, running: false, procs: [], project: "" };

		/** SSE 为主，失败自动降级为 10s 轮询 */
		const useDevprocState = () => {
			const [state, setState] = useState(emptyState);
			const [live, setLive] = useState(false);

			useEffect(() => {
				let source = null;
				let poller = null;
				let disposed = false;

				const apply = (data) => {
					if (!data || typeof data !== "object") return;
					if (!Array.isArray(data.procs)) data.procs = [];
					setState(data);
				};

				const startPoller = () => {
					if (poller || disposed) return;
					setLive(false);
					const tick = async () => {
						try {
							const res = await fetch(API_STATUS, { cache: "no-store" });
							apply(await res.json());
						} catch {
							/* 忽略单次失败 */
						}
					};
					tick();
					poller = setInterval(tick, 10000);
				};

				try {
					source = new EventSource(API_STREAM);
					source.addEventListener("open", () => setLive(true));
					source.addEventListener("status", (event) => {
						try {
							apply(JSON.parse(event.data));
						} catch {
							/* 忽略坏帧 */
						}
					});
					source.addEventListener("error", () => {
						setLive(false);
						startPoller();
					});
				} catch {
					startPoller();
				}

				return () => {
					disposed = true;
					try {
						if (source) source.close();
					} catch {
						/* 忽略 */
					}
					if (poller) clearInterval(poller);
				};
			}, []);

			return { state, live };
		};

		/* ---------------------------------------------------------------- 胶囊 */

		const copyText = async (text) => {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* 降级 */
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				document.body.removeChild(area);
				return ok;
			} catch {
				return false;
			}
		};

		const absDist = (project, distPath) => {
			if (!distPath) return "";
			const root = String(project || "").replace(/\//g, "\\").replace(/\\$/, "");
			const rel = String(distPath).replace(/\//g, "\\");
			if (/^[a-zA-Z]:/.test(rel)) return rel;
			return root ? root + "\\" + rel : rel;
		};

		/** 代理改动标记：正在修改 / 已改好 */
		const agentTag = (agent) => {
			const st = agent && agent.state;
			if (st !== "editing" && st !== "done") return null;
			const editing = st === "editing";
			const tip = [
				editing ? "代理正在改这个项目" : "代理改完了，等你验收",
				agent.note || "",
				agent.files && agent.files.length ? agent.files.join("\n") : ""
			]
				.filter(Boolean)
				.join("\n");
			return h(
				"span",
				{ className: "dvp__tag " + (editing ? "dvp__tag--busy" : "dvp__tag--done"), title: tip },
				editing ? "正在修改" : "已改好 ✓"
			);
		};

		const dotClass = (proc, agent) => {
			const st = agent && agent.state;
			if (st === "editing") return "dvp__dot dvp__dot--busy";
			if (st === "done") return "dvp__dot dvp__dot--done";
			return "dvp__dot" + (proc.port ? "" : " dvp__dot--idle");
		};

		const Pill = ({ proc, project, agent }) => {
			const [busy, setBusy] = useState(false);
			const [flash, setFlash] = useState("");
			const timer = useRef(null);

			useEffect(
				() => () => {
					if (timer.current) clearTimeout(timer.current);
				},
				[]
			);

			const say = (text) => {
				setFlash(text);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setFlash(""), 1500);
			};

			const url = proc.url || (proc.port ? "http://127.0.0.1:" + proc.port : "");
			// 没有产物目录（H5 dev 走内存编译）时退到项目根目录
			const folder = absDist(project, proc.distPath) || String(project || "").replace(/\//g, "\\");
			const folderTip = proc.distPath ? "打开产物目录" : "打开项目目录";
			const label = proc.label || proc.platform || "dev";
			const tail = proc.port ? String(proc.port) : "已就绪";

			const handleCopy = async () => {
				const ok = await copyText(url || folder || "");
				say(ok ? "已复制" : "复制失败");
			};

			const handleOpen = async () => {
				if (!url) return say("无地址");
				setBusy(true);
				const res = await postJson(API_OPEN, { target: url });
				setBusy(false);
				say(res && res.ok ? "已打开" : (res && res.error) || "打开失败");
			};

			const handleFolder = async () => {
				if (!folder) return say("无目录");
				setBusy(true);
				const res = await postJson(API_OPEN, { target: folder });
				setBusy(false);
				if (res && res.ok) say(res.fallback ? "已打开项目目录" : "已打开");
				else say((res && res.error) || "打开失败");
			};

			const handleStop = async () => {
				setBusy(true);
				const res = await postJson(API_STOP, { pid: proc.pid });
				setBusy(false);
				say(res && res.ok ? "已关闭" : "关闭失败");
			};

			// 只有小程序类进程才有「用微信开发者工具打开」这一步
			const isMini = /^mp/.test(String(proc.platform || ""));
			const handleWechat = async () => {
				setBusy(true);
				const res = await postJson(API_WECHAT, { target: proc.distPath ? absDist(project, proc.distPath) : "" });
				setBusy(false);
				if (res && res.ok) {
					say(res.started ? "正在启动开发者工具…" : res.method === "rest" ? "已切到当前项目" : "已打开当前项目");
				} else if (res && res.needsServicePort) {
					say("服务端口没开：设置 → 安全设置 → 服务端口");
				} else {
					say((res && (res.hint || res.error)) || "打开失败");
				}
			};

			return h(
				"div",
				{ className: "dvp", title: label + (url ? " · " + url : folder ? " · " + folder : "") },
				h("span", { className: dotClass(proc, agent) }),
				h("span", { className: "dvp__text" }, flash || label + " · " + tail),
				agentTag(agent),
				h("span", { className: "dvp__sep" }),
				h(
					"button",
					{ className: "dvp__btn", type: "button", title: "复制地址", disabled: busy, onClick: handleCopy },
					"⧉"
				),
				h(
					"button",
					{ className: "dvp__btn", type: "button", title: "打开浏览器", disabled: busy || !url, onClick: handleOpen },
					"↗"
				),
				h(
					"button",
					{ className: "dvp__btn", type: "button", title: folderTip, disabled: busy || !folder, onClick: handleFolder },
					"▤"
				),
				isMini
					? h(
							"button",
							{
							className: "dvp__btn",
							type: "button",
							title: "用微信开发者工具打开当前项目（需在 IDE 设置 → 安全设置 开启服务端口）",
							disabled: busy,
							onClick: handleWechat
						},
							"微"
						)
					: null,
				h(
					"button",
					{ className: "dvp__btn dvp__btn--danger", type: "button", title: "关闭进程", disabled: busy, onClick: handleStop },
					"✕"
				)
			);
		};

		const mounted = { current: false };

		const Chip = () => {
			const { state } = useDevprocState();
			const procs = Array.isArray(state.procs) ? state.procs.slice(0, 3) : [];
			const agent = state.agent || null;

			useEffect(() => {
				mounted.current = true;
			}, []);

			// 没有 dev 进程时，只要有代理改动状态也单独给一枚胶囊
			if (procs.length === 0) {
				if (!agent || (agent.state !== "editing" && agent.state !== "done")) return null;
				return h(
					"div",
					{ className: "dvp-wrap" },
					h(
						"div",
						{ className: "dvp", title: "开发服务未运行" },
						h("span", { className: dotClass({ port: null }, agent) }),
						h("span", { className: "dvp__text" }, "开发服务未运行"),
						agentTag(agent)
					)
				);
			}

			return h(
				"div",
				{ className: "dvp-wrap" },
				procs.map((proc, index) => h(Pill, { key: (proc.pid || "p") + "-" + index, proc, project: state.project, agent }))
			);
		};

		/* -------------------------------------------------------------- 设置页 */

		const PLATFORMS = [
			{ id: "h5", name: "H5" },
			{ id: "mp-weixin", name: "微信小程序" },
			{ id: "mp-alipay", name: "支付宝小程序" },
			{ id: "app", name: "App" }
		];

		const SettingsView = () => {
			const [config, setConfig] = useState({ pollMs: 3000, project: "", showPlatforms: [], probeUrls: true, wechatCli: "" });
			const [file, setFile] = useState("");
			const [hint, setHint] = useState("");
			const [saving, setSaving] = useState(false);

			useEffect(() => {
				let alive = true;
				fetch(API_CONFIG, { cache: "no-store" })
					.then((res) => res.json())
					.then((data) => {
						if (!alive || !data || !data.config) return;
						setConfig({
							pollMs: data.config.pollMs || 3000,
							project: data.config.project || "",
							showPlatforms: Array.isArray(data.config.showPlatforms) ? data.config.showPlatforms : [],
							probeUrls: data.config.probeUrls !== false,
							wechatCli: data.config.wechatCli || ""
						});
						if (data.file) setFile(data.file);
					})
					.catch(() => null);
				return () => {
					alive = false;
				};
			}, []);

			const togglePlatform = (id) => {
				setConfig((prev) => {
					const has = prev.showPlatforms.includes(id);
					return {
						...prev,
						showPlatforms: has ? prev.showPlatforms.filter((item) => item !== id) : prev.showPlatforms.concat(id)
					};
				});
			};

			const save = async () => {
				setSaving(true);
				const res = await postJson(API_CONFIG, config);
				setSaving(false);
				setHint(res && res.ok ? "已保存，立刻生效" : "保存失败：" + ((res && res.error) || "未知错误"));
			};

			return h(
				"div",
				{ className: "dvp-set" },
				h(
					"div",
					{ className: "dvp-set__row" },
					h("span", { className: "dvp-set__label" }, "刷新间隔"),
					h("input", {
						className: "dvp-set__input",
						type: "number",
						min: 1000,
						max: 60000,
						step: 500,
						value: config.pollMs,
						onChange: (event) => setConfig({ ...config, pollMs: Number(event.target.value) || 3000 })
					}),
					h("span", { className: "dvp-set__hint" }, "毫秒，最小 1000；仅一个后台采样器，不看页面时自动停")
				),
				h(
					"div",
					{ className: "dvp-set__row" },
					h("span", { className: "dvp-set__label" }, "项目路径"),
					h("input", {
						className: "dvp-set__input",
						type: "text",
						placeholder: "留空则用 DSH 当前工作区默认值",
						value: config.project,
						onChange: (event) => setConfig({ ...config, project: event.target.value })
					})
				),
				h(
					"div",
					{ className: "dvp-set__row" },
					h("span", { className: "dvp-set__label" }, "微信开发者工具"),
					h("input", {
						className: "dvp-set__input",
						type: "text",
						placeholder: "cli.bat 路径，留空自动探测",
						value: config.wechatCli,
						onChange: (event) => setConfig({ ...config, wechatCli: event.target.value })
					}),
					h("span", { className: "dvp-set__hint" }, "小程序胶囊上的「微」按钮用它打开项目")
				),
				h(
					"div",
					{ className: "dvp-set__row" },
					h("span", { className: "dvp-set__label" }, "只显示平台"),
					h(
						"span",
						{ style: { display: "inline-flex", gap: "14px", flexWrap: "wrap" } },
						PLATFORMS.map((item) =>
							h(
								"label",
								{ key: item.id, className: "dvp-set__check" },
								h("input", {
									type: "checkbox",
									checked: config.showPlatforms.includes(item.id),
									onChange: () => togglePlatform(item.id)
								}),
								item.name
							)
						)
					)
				),
				h(
					"div",
					{ className: "dvp-set__row" },
					h("span", { className: "dvp-set__label" }, "URL 真实探测"),
					h(
						"label",
						{ className: "dvp-set__check" },
						h("input", {
							type: "checkbox",
							checked: config.probeUrls,
							onChange: () => setConfig({ ...config, probeUrls: !config.probeUrls })
						}),
						"用 HTTP 请求确认根路径能否打开（否则直接用端口拼地址）"
					)
				),
				h(
					"div",
					{ className: "dvp-set__row" },
					h(
						"button",
						{ className: "dvp-set__btn", type: "button", disabled: saving, onClick: save },
						saving ? "保存中…" : "保存"
					),
					h("span", { className: "dvp-set__hint" }, hint || (file ? "配置文件：" + file : ""))
				)
			);
		};

		/* -------------------------------------------------------------- 注册 */

		const registerSlot = (ctx, slots, name, options, render) => {
			try {
				slots.inject(name, () => {
					const dispose = slots.register({ name, ...options }, render);
					try {
						if (ctx && typeof ctx.effect === "function") {
							ctx.effect(
								() => () => {
									try {
										if (typeof dispose === "function") dispose();
									} catch {
										/* 忽略 */
									}
								},
								"devproc: slot " + name
							);
						}
					} catch {
						/* 忽略 */
					}
					return dispose;
				});
				return true;
			} catch {
				return false;
			}
		};

		const CANDIDATES = [
			"conversation.input.dock",
			"conversation.composer.bar",
			"conversation.composer.dock",
			"conversation.session.header.utilities"
		];

		const apply = (ctx) => {
			injectCss();
			const slots = ctx && ctx.slots;
			if (!slots) return;

			// 主槽位，失败或 2.5s 内没渲染则顺延下一个
			const tryRegister = (index) => {
				if (index >= CANDIDATES.length) return;
				const name = CANDIDATES[index];
				registerSlot(ctx, slots, name, { id: "dsh-devproc-chip", order: 40 }, () => guard(h(Chip)));
				setTimeout(() => {
					if (!mounted.current) tryRegister(index + 1);
				}, 2500);
			};
			tryRegister(0);

			// 设置页
			registerSlot(ctx, slots, "settings.section", { id: "dsh-devproc-settings", order: 40, label: () => "终端进程" }, () =>
				guard(h(SettingsView))
			);
		};

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
