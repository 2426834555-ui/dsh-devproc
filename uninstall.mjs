#!/usr/bin/env node
// 一键卸载 dsh-devproc：从 profile 摘掉 bundle + 依赖，删 junction。
//   node uninstall.mjs
import { readFileSync, writeFileSync, existsSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const NAME = "dsh-devproc";
const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(HOME, "profiles", "desktop");
const pkgPath = join(profileDir, "package.json");
const link = join(profileDir, "node_modules", NAME);

if (existsSync(pkgPath)) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (pkg.dependencies) delete pkg.dependencies[NAME];
	const bundles = pkg.dsh?.profile?.bundles;
	if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((b) => b !== NAME);
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
	console.log("已从 profile 移除 " + NAME);
}

try {
	if (lstatSync(link)) rmSync(link, { recursive: true, force: true });
	console.log("已删除 junction");
} catch {
	/* 不存在 */
}

console.log("完成。完全退出 DSH 再打开即可恢复原状。");
