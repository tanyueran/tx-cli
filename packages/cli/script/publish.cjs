const { execSync, exec } = require("node:child_process");
const { readFileSync, writeFileSync } = require("fs-extra");
const { simpleGit } = require("simple-git");

const git = simpleGit();
let version = "0.0.1";

/**
 * 更新版本号
 */
function updateVersion() {
  const json = JSON.parse(readFileSync("./package.json", "utf-8"));
  version = json.version;
  let vList = version.split(".").map((v) => parseInt(v));
  version = `${vList[0]}.${vList[1]}.${vList[2] + 1}`;
  json.version = version;
  writeFileSync("./package.json", JSON.stringify(json, null, 2));
}

/**
 * 回滚版本号
 */
function rollbackVersion() {
  try {
    execSync("git checkout ./packages/cli/package.json");
    console.log("版本号回滚成功");
  } catch (err) {
    console.error("版本号回滚失败，请手动处理：", error);
    process.exit(1);
  }
}

/**
 * 构建
 */
function build() {
  try {
    exec("pnpm run build", {
      stdio: "inherit",
    });
    console.log("构建完成");
  } catch (err) {
    console.error("提交失败:", error);
    // 打包失败，回滚版本号
    rollbackVersion();
  }
}

/**
 * 提交代码
 */
async function commit() {
  try {
    await git.add(".");
    await git.commit(`chore: v${version}`);
    await git.push("origin", "main");
    console.log("提交完成");
  } catch (err) {
    console.error("提交失败:", error);
    process.exit(1);
  }
}

/**
 * 打tag
 */
async function playTag() {
  try {
    await git.addTag(`v${version}`);
    console.log("打tag完成");
    await git.pushTags("origin");
    console.log("tag推送完成");
  } catch (err) {
    console.error("打tag失败:", error);
    process.exit(1);
  }
}

/**
 * 发布
 */
async function publish() {
  try {
    await exec("npm publish --access public");
  } catch (err) {
    console.error("发布失败:", err);
    process.exit(1);
  }
}

async function release() {
  // 修改版本号
  updateVersion();
  // 打包构建
  build();
  // 提交修改 到 远程仓库
  await commit();
  // 创建 tag
  await playTag();
  // 发包
  await publish();
}

release();
