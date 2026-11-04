#!/usr/bin/env bash
# Background sampler: dump state of any node process that is older than 2.5 s.
set -u
mkdir -p probe-out
seen=" "
while true; do
  for pid in $(pgrep -x node); do
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$age" ] && continue
    args=$(tr '\0' ' ' </proc/"$pid"/cmdline 2>/dev/null)
    case "$args" in *tsdown.config.ts*) ;; *) continue ;; esac
    if [ "$age" -ge 3 ] && [[ "$seen" != *" $pid "* ]]; then
      seen="$seen$pid "
      {
        echo "### slow node pid=$pid age=${age}s at $(date +%T.%N)"
        echo "cmd: $args"
        ps -L -o pid,lwp,stat,pcpu,wchan:32,comm -p "$pid"
        sudo grep -E 'State|Threads|VmRSS|voluntary' /proc/"$pid"/status
        sudo cat /proc/"$pid"/io
        for t in /proc/"$pid"/task/*; do echo "-- $t $(cat "$t"/comm) wchan=$(sudo cat "$t"/wchan)"; sudo cat "$t/stack" 2>/dev/null | head -12; done
        sudo ls -l /proc/"$pid"/fd
        cat /proc/pressure/io /proc/pressure/cpu /proc/pressure/memory
        vmstat 1 2
        sudo gdb -q -batch -p "$pid" -ex "thread apply all bt 30" 2>&1 | head -400
        sudo timeout 3 strace -f -tt -T -p "$pid" 2>&1 | tail -100
        echo "### after diag: $(ps -o etimes=,stat= -p "$pid" 2>/dev/null || echo gone)"
      } >>probe-out/diag.txt 2>&1
    fi
  done
  sleep 0.2
done
