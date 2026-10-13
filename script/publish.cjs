const { execSync } = require("node:child_process");
const { readFileSync } = require("fs-extra");
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

/** 当前发布版本号 */
let version = "0.0.1";

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
  return JSON.parse(readFileSync("./package.json", "utf-8"));
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
      run(`npm version ${versionType} --no-git-tag-version`);
    } else {
      run("npm version prerelease --preid=beta --no-git-tag-version");
    }
  } catch (err) {
    console.log(pico.red(`更新版本号失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 自动生成 changelog 并同步当前版本号
 * @returns {void}
 */
function generateChangelog() {
  try {
    run("npm run changelog");
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
    run("npm run build");
    console.log(pico.green("构建完成"));
  } catch (err) {
    console.log(pico.red(`构建失败: ${err.message}`));
    process.exit(1);
  }
}

/**
 * 发布前校验：确认已登录 npm 且目标版本未被占用
 * @returns {void}
 */
function preCheck() {
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

    console.log("正在发布到 npm...");
    run(`npm publish --access ${ACCESS}`, {
      env: { ...process.env, npm_config_otp: otp.trim() },
    });
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
    const { current: branch } = await git.branchLocal();
    await git.add(".");
    await git.commit(`release: v${version}`);
    await git.addTag(`v${version}`);
    await git.push(REMOTE, branch);
    await git.pushTags(REMOTE);
    console.log(pico.green("提交、打 tag 并推送完成"));
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
  generateChangelog();
  // 3. 打包构建
  logStep(3, "打包构建");
  build();
  // 4. 发布前校验
  logStep(4, "发布前校验");
  preCheck();
  // 5. 发布到 npm
  logStep(5, "发布到 npm");
  await publishPkg();
  // 6. 提交代码并打 tag
  logStep(6, "提交代码并打 tag");
  await releaseGit();

  console.log(pico.green(`\n🎉 发布成功：v${version}`));
}

start();
