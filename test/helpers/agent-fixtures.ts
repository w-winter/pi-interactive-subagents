import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function writeAgentFile(agentsDir: string, name: string, frontmatter: string, body = "You are a test agent.") {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\nextension: pi-interactive-subagents\n${frontmatter}\n---\n\n${body}\n`);
}

export async function withIsolatedAgentEnv(fn: (paths: {
  projectDir: string; projectAgentsDir: string; globalDir: string; globalAgentsDir: string;
}) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "pis-agent-definitions-"));
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");
  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;
  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    execFileSync("trash", [root]);
  }
}
