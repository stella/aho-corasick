#!/usr/bin/env bash
# Experiment: time native Node importing tsdown.config.ts and capture state of slow runs.
set -u
mode="${1:-seq}"
iterations="${2:-150}"
url="file://$PWD/tsdown.config.ts"
script='process.on("exit",()=>process.stderr.write(`P exit=${performance.now().toFixed(1)}\n`));process.stderr.write(`P start=${performance.now().toFixed(1)}\n`);await import(process.argv[1]);process.stderr.write(`P imported=${performance.now().toFixed(1)}\n`);'
mkdir -p probe-out

echo "== env"; which -a node; node -v; nproc; free -m; cat /proc/pressure/io /proc/pressure/cpu 2>/dev/null; uptime

diagnose() {
  local pid=$1 tag=$2
  {
    echo "### $tag pid=$pid at $(date +%T.%N)"
    ps -L -o pid,lwp,stat,pcpu,wchan:32,comm -p "$pid"
    sudo cat /proc/"$pid"/status | head -20
    for t in /proc/"$pid"/task/*; do echo "-- $t $(cat $t/comm) $(sudo cat $t/wchan)"; sudo cat "$t/stack" 2>/dev/null | head -12; done
    sudo ls -l /proc/"$pid"/fd
    cat /proc/pressure/io /proc/pressure/cpu /proc/pressure/memory 2>/dev/null
    sudo gdb -q -batch -p "$pid" -ex "thread apply all bt 25" 2>&1 | head -400
    sudo timeout 3 strace -f -tt -T -p "$pid" 2>&1 | tail -80
  } >>probe-out/diag.txt 2>&1
}

one() {
  local i=$1 extra=$2
  local t0 t1 pid status
  t0=$(date +%s%N)
  # Exact test command, plus the phase markers on stderr.
  node --input-type=module -e "$script" "$url" </dev/null >probe-out/out.$i 2>probe-out/err.$i $extra &
  pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.05
    waited=$((waited + 1))
    if [ "$waited" -eq 60 ]; then diagnose "$pid" "iter $i >3s"; fi
    if [ "$waited" -eq 1200 ]; then diagnose "$pid" "iter $i >60s"; kill -9 "$pid"; fi
  done
  wait "$pid"; status=$?
  t1=$(date +%s%N)
  local ms=$(( (t1 - t0) / 1000000 ))
  echo "iter=$i status=$status total_ms=$ms $(tr '\n' ' ' <probe-out/err.$i | grep -o 'P [a-z]*=[0-9.]*' | tr '\n' ' ')"
}

case "$mode" in
  seq)
    for i in $(seq 1 "$iterations"); do one "$i" ""; done ;;
  cold)
    for i in $(seq 1 "$iterations"); do sync; sudo sh -c 'echo 3 >/proc/sys/vm/drop_caches'; one "cold$i" ""; done ;;
  par)
    for i in $(seq 1 "$iterations"); do
      for j in 1 2 3 4 5 6 7 8; do one "p$i.$j" "" & done; wait
    done ;;
  buntest)
    for i in $(seq 1 "$iterations"); do
      bun test scripts/shared-policy.test.ts 2>&1 | grep -E "native Node|toolchain guard|fail"
    done ;;
esac
