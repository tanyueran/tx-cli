const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("fs-extra");
const { simpleGit } = require("simple-git");
const prompts = require("prompts");
const pico = require("picocolors");

const git = simpleGit();

/** 远程仓库名 */
const REMOTE = "origin";
/** npm 包访问级别 */
const ACCESS = "public";
/** 发布流程总步骤数 */
const TOTAL_STEPS = 6;
/** 待发布包目录 */
const PACKAGE_DIR = "packages/cli";
/** 需要与 CLI 版本保持一致的 package.json（根包 + 各 workspace 包） */
const VERSION_SYNC_FILES = [
  "package.json",
  "packages/agent-common/package.json",
  "packages/agent-core/package.json",
  "packages/agent-scaffold/package.json",
];

/** 当前发布版本号 */
let version = "0.0.1";
/** npm 发布通道 */
let distTag = "latest";

/**
 * 执行 shell 命令并将输出透传到当前终端
 * @param {string} command - 待执行的命令
 * @param {import("node:child_process").ExecSyncOptions} [options] - execSync 的额外配置
 * @returns {void}
 */
function run(command, options = {}) {
  execSync(command, { stdio: "inherit", ...options });
}

/**
 * 读取并解析 package.json
 * @returns {{ name: string, version: string }} package.json 中的名称与版本信息
 */
function readPkg() {
  return JSON.parse(readFileSync(`${PACKAGE_DIR}/package.json`, "utf-8"));
}

/**
 * 把 CLI 的最新版本号同步写入根包与其他 workspace 包，避免版本号漂移
 * @param {string} nextVersion - 待同步的版本号
 * @returns {void}
 */
function syncWorkspaceVersions(nextVersion) {
  for (const file of VERSION_SYNC_FILES) {
    const pkg = JSON.parse(readFileSync(file, "utf-8"));
    if (pkg.version === nextVersion) {
      continue;
    }
    pkg.version = nextVersion;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }
}

/**
 * 获取当前子包对应的独立 Git tag
 * @returns {string} 由包名和版本号组成的 tag
 */
function getReleaseTag() {
  return `${readPkg().name}@${version}`;
}

/**
 * 打印带步骤序号的进度提示
 * @param {number} step - 当前步骤序号
 * @param {string} message - 提示文案
 * @returns {void}
 */
function logStep(step, message) {
  console.log(pico.cyan(`\n[${step}/${TOTAL_STEPS}] ${message}`));
}

/**
 * 用户取消 prompt 时的统一处理
 * @returns {void}
 */
function onCancel() {
  console.log(pico.yellow("\n已取消发布"));
  process.exit(1);
}

/**
 * 更新版本号
 * @returns {Promise<void>}
 */
async function updateVersion() {
  const status = await git.status();
  if (!status.isClean()) {
    console.log(pico.yellow("请保证工作空间是干净的"));
    process.exit(1);
  }
  try {
    const { isRelease } = await prompts(
      {
        type: "confirm",
        name: "isRelease",
        message: "是否发布正式版本？",
      },
      { onCancel },
    );

    distTag = isRelease ? "latest" : "beta";

    if (isRelease) {
      // 选择版本类型（major、minor、patch）
      const { versionType } = await prompts(
        {
          type: "select",
          name: "versionType",
          message: "请选择版本类型",
          choices: [
            { title: "重大更新：major", value: "major" },
            { title: "小更新：minor", value: "minor" },
            { title: "热修：patch", value: "patch" },
          ],
        },
        { onCancel },
      );
      run(`npm version ${versionType} --no-git-tag-version`, {
        cwd: PACKAGE_DIR,
      });
    } else {
      run("npm version prerelease --preid=beta --no-git-tag-version", {
        cwd: PACKAGE_DIR,
      });
    }
    // CLI 版本变更后同步根包与其余 workspace 包，保持仓库内版本一致
    syncWorkspaceVersions(readPkg().version);
  } catch (err) {
    console.log(pico.red(`更新版本号失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 校验发布历史一致性：包的最新 Git tag 必须位于当前 HEAD 的历史中
 *
 * 背景：历史被改写（rebase、重新初始化仓库等）后，旧 tag 会指向游离提交；
 * conventional-changelog 找不到可达的上一个版本 tag，只能回退到更早的 tag，
 * 导致新版本重复收录旧提交。发布前直接失败，避免生成错误的 changelog。
 * @returns {Promise<void>}
 */
async function assertReleaseHistory() {
  const tagPrefix = `${readPkg().name}@`;
  const rawTags = await git.raw([
    "tag",
    "--list",
    `${tagPrefix}*`,
    "--sort=-v:refname",
  ]);
  const latestTag = rawTags
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)[0];
  if (!latestTag) {
    return;
  }
  try {
    await git.raw(["merge-base", "--is-ancestor", latestTag, "HEAD"]);
  } catch {
    console.log(
      pico.red(
        `最新发布 tag ${latestTag} 不在当前提交历史中（历史可能被改写），` +
          "继续发布会重复收录旧提交。请先修正该 tag 的指向后重试。",
      ),
    );
    process.exit(1);
  }
}

/**
 * 自动生成 changelog 并同步当前版本号
 * @returns {void}
 */
function generateChangelog() {
  try {
    run("pnpm run changelog");
    version = readPkg().version;
  } catch (err) {
    console.log(pico.red(`生成 changelog 失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 构建产物
 * @returns {void}
 */
function build() {
  try {
    run("pnpm run build");
    console.log(pico.green("构建完成"));
  } catch (err) {
    console.log(pico.red(`构建失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 发布前校验：确认已登录 npm，且目标版本和 Git tag 均未被占用
 * @returns {Promise<void>}
 */
async function preCheck() {
  try {
    execSync("npm whoami", { stdio: "ignore" });
  } catch {
    console.log(pico.red("未登录 npm，请先执行 npm login"));
    process.exit(1);
  }

  const pkg = readPkg();
  try {
    execSync(`npm view ${pkg.name}@${version} version`, { stdio: "ignore" });
    console.log(
      pico.yellow(`版本 ${pkg.name}@${version} 已存在于 npm，请更换版本号`),
    );
    process.exit(1);
  } catch {
    // 查询不到说明版本未被占用，正常继续
  }

  const releaseTag = getReleaseTag();
  try {
    const localTag = await git.raw(["tag", "--list", releaseTag]);
    const remoteTag = await git.raw([
      "ls-remote",
      "--tags",
      REMOTE,
      `refs/tags/${releaseTag}`,
    ]);
    if (localTag.trim() || remoteTag.trim()) {
      console.log(pico.yellow(`Git tag ${releaseTag} 已存在，请更换版本号`));
      process.exit(1);
    }
  } catch (err) {
    console.log(pico.red(`检查 Git tag 失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 发布到 npm（先发布，成功后再提交代码，避免出现「幽灵版本」）
 * @returns {Promise<void>}
 */
async function publishPkg() {
  try {
    // 询问用户输入 OTP，通过环境变量传递，避免出现在进程列表
    const { otp } = await prompts(
      {
        type: "text",
        name: "otp",
        message: "请输入 npm 账户的双因素认证代码(OTP): ",
      },
      { onCancel },
    );

    if (!otp) {
      console.log(pico.red("OTP 无效输入"));
      process.exit(1);
    }

    console.log(`正在发布 ${getReleaseTag()} 到 npm ${distTag} 通道...`);
    // 版本号和 changelog 已在发布前修改，跳过 pnpm 对脏工作区的重复检查
    run(
      `pnpm publish --access ${ACCESS} --tag ${distTag} --no-git-checks`,
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, npm_config_otp: otp.trim() },
      },
    );
    console.log(pico.gray("发布成功!"));
  } catch (err) {
    console.log(pico.red(`发布失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 提交代码并推送 tag 到远程仓库
 * @returns {Promise<void>}
 */
async function releaseGit() {
  try {
    const releaseTag = getReleaseTag();
    const { current: branch } = await git.branchLocal();
    await git.add(".");
    await git.commit(`release: ${releaseTag}`);
    await git.addTag(releaseTag);
    await git.push(REMOTE, branch);
    await git.pushTags(REMOTE);
    console.log(pico.green(`提交、打 tag ${releaseTag} 并推送完成`));
  } catch (err) {
    console.log(pico.red(`提交失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 发布流程入口
 * @returns {Promise<void>}
 */
async function start() {
  // 1. 更新版本号
  logStep(1, "更新版本号");
  await updateVersion();
  // 2. 生成 changelog
  logStep(2, "生成 changelog");
  await assertReleaseHistory();
  generateChangelog();
  // 3. 打包构建
  logStep(3, "打包构建");
  build();
  // 4. 发布前校验
  logStep(4, "发布前校验");
  await preCheck();
  // 5. 发布到 npm
  logStep(5, "发布到 npm");
  await publishPkg();
  // 6. 提交代码并打 tag
  logStep(6, "提交代码并打 tag");
  await releaseGit();

  console.log(pico.green(`\n🎉 发布成功：${getReleaseTag()}`));
}

start();
