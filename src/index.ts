import { program } from "./program";

export function start() {
  program.parse(process.argv);
}
