import { Command } from "commander";
import * as pkg from "../../package.json";

const program = new Command();
program.name("tx cli").description("一个简单CLI 工具").version(pkg.version);

export { program };
