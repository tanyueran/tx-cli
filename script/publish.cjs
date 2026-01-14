const { execSync } = require("node:child_process");
const { readFileSync } = require("fs-extra");
const { simpleGit } = require("simple-git");
const prompts = require("prompts");
const pico = require("picocolors");

const git = simpleGit();
let version = "0.0.1";

/**
 * 更新版本号
 */
async function updateVersion() {
  const status = await git.status();
  if (!status.isClean()) {
    console.log(pico.yellow("请保证工作空间是干净的"));
    process.exit(1);
  }
  try {
    const { isRelease } = await prompts({
      type: "confirm",
      name: "isRelease",
      message: "是否发布正式版本？",
    });
    if (isRelease) {
      // 选择版本类型（major、minor、patch）
      const { versionType } = await prompts({
        type: "select",
        name: "versionType",
        message: "请选择版本类型",
        choices: [
          { title: "重大更新：major", value: "major" },
          { title: "小更新：minor", value: "minor" },
          { title: "热修：patch", value: "patch" },
        ],
      });
      execSync(`npm version ${versionType} --no-git-tag-version`);
    } else {
      execSync(`npm version prerelease --preid=beta --no-git-tag-version`);
    }
  } catch (err) {
    console.log(pico.red("更新版本号失败：", err));
    process.exit(1);
  }
}

/**
 * 自动生成日志
 */
function autoGeneratorLog() {
  try {
    execSync("npm run changelog");
    // 读取版本号
    const json = JSON.parse(readFileSync("./package.json", "utf-8"));
    version = json.version;
  } catch (err) {
    console.log(pico.red("生成 changelog 失败：", err));
    process.exit(1);
  }
}

/**
 * 构建
 */
function build() {
  try {
    execSync("pnpm run build", {
      stdio: "inherit",
    });
    console.log(pico.green("构建完成"));
  } catch (err) {
    console.error(pico.red("提交失败:", error));
  }
}

/**
 * 提交代码
 */
async function commit() {
  try {
    await git.add(".");
    await git.commit(`release: v${version}`);
    await git.push("origin", "main");
    console.log(pico.green("提交完成"));
  } catch (err) {
    console.error(pico.red("提交失败:", error));
    process.exit(1);
  }
}

/**
 * 打tag
 */
async function playTag() {
  try {
    await git.addTag(`v${version}`);
    console.log(pico.green("打tag完成"));
    await git.pushTags("origin");
    console.log(pico.green("tag推送完成"));
  } catch (err) {
    console.error(pico.red("打tag失败:", err));
    process.exit(1);
  }
}

/**
 * 发布
 */
async function publishPkg() {
  try {
    // 询问用户输入OTP
    const { otp } = await prompts([
      {
        type: "text",
        name: "otp",
        message: "请输入npm账户的双因素认证代码(OTP): ",
      },
    ]);
    console.log("正在发布到npm...");
    if (otp) {
      execSync(`npm publish --otp=${otp.trim()} --access public `, {
        stdio: "inherit",
      });
      console.log(pico.gray("发布成功!"));
    } else {
      console.log(pico.red("OTP无效输入"));
      process.exit(1);
    }
  } catch (err) {
    console.error(pico.red("发布失败:", err));
    process.exit(1);
  }
}

async function start() {
  await updateVersion();
  autoGeneratorLog();
  // 打包构建
  build();
  // 提交修改 到 远程仓库
  await commit();
  // 创建 tag
  await playTag();
  // 发包
  await publishPkg();
}

start();
