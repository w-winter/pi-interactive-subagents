import { shellEscape } from "./mux.ts";

/** Gate the existing foreground CLI on a first-writer claim and retain its actual shell status. */
export function buildRunCommand(params: {
  id: string; runDir: string; execCommand: string; cwd: string;
}): string {
  if (!/^[a-zA-Z0-9-]+$/.test(params.id)) throw new Error("Invalid generated execution id");
  const inner = `
claim=$1
supervisor_pid=$2
supervisor_start=$3
run_dir=${shellEscape(params.runDir)}
fail_start() {
  failure=$(/usr/bin/mktemp "$run_dir/.bootstrap.XXXXXXXX")
  observed=$(/bin/date +%s)
  if [ -n "$failure" ] && printf '{"kind":"not_started","id":"${params.id}","observedAt":%s000,"cause":"bootstrap_failed"}\\n' "$observed" > "$failure"; then
    /bin/ln "$failure" "$run_dir/process.json" 2>/dev/null
  fi
  /usr/bin/unlink "$failure" 2>/dev/null
  printf '[subagents:launch] {"event":"bootstrap_failed","id":"${params.id}"}\\n' >&2
  exit 1
}
[ -n "$claim" ] || fail_start
executor_start=$(LC_ALL=C TZ=UTC /bin/ps -p "$$" -o lstart=) || fail_start
executor_start=$(printf '%s' "$executor_start" | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
[ -n "$executor_start" ] && [ -n "$supervisor_start" ] || fail_start
printf '{"kind":"claimed","id":"${params.id}","executor":{"pid":%s,"started":"%s"},"supervisor":{"pid":%s,"started":"%s"}}\\n' "$$" "$executor_start" "$supervisor_pid" "$supervisor_start" > "$claim" || fail_start
if /bin/ln "$claim" "$run_dir/process.json" 2>/dev/null && [ "$claim" -ef "$run_dir/process.json" ]; then
  cd ${shellEscape(params.cwd)} || exit 1
  ${params.execCommand}
else
  exit 1
fi`;
  return `
run_dir=${shellEscape(params.runDir)}
claim=$(/usr/bin/mktemp "$run_dir/.claim.XXXXXXXX") || claim=""
supervisor_pid=$$
supervisor_start=$(LC_ALL=C TZ=UTC /bin/ps -p "$$" -o lstart=)
supervisor_start=$(printf '%s' "$supervisor_start" | /usr/bin/sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
/bin/bash -c ${shellEscape(inner)} subagent-launch "$claim" "$supervisor_pid" "$supervisor_start"
command_status=$?
if [ "$claim" -ef "$run_dir/process.json" ]; then
  exited=$(/bin/date +%s)
  receipt=$(/usr/bin/mktemp "$run_dir/.exit.XXXXXXXX")
  if [ -n "$receipt" ] && printf '{"id":"${params.id}","exitCode":%s,"exitedAt":%s000,"supervisor":{"pid":%s,"started":"%s"}}\\n' "$command_status" "$exited" "$supervisor_pid" "$supervisor_start" > "$receipt"; then
    /bin/ln "$receipt" "$run_dir/shell-exit.json" 2>/dev/null || printf '[subagents:completion-file] {"event":"shell_receipt_unavailable","id":"${params.id}"}\\n' >&2
  else
    printf '[subagents:completion-file] {"event":"shell_receipt_write_failed","id":"${params.id}"}\\n' >&2
  fi
  /usr/bin/unlink "$receipt" 2>/dev/null
fi
/usr/bin/unlink "$claim" 2>/dev/null
printf '__SUBAGENT_DONE_%s__\\n' "$command_status"
`;
}
