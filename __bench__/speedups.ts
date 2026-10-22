type SpeedupOptions = { names: string[]; times: number[] };

export const speedupRows = ({ names, times }: SpeedupOptions) => {
  const baseline = times.at(0);
  if (baseline === undefined) throw new Error("Missing baseline timing");
  const rows: string[] = [];
  for (const [index, name] of names.entries()) {
    if (index === 0) continue;
    const elapsed = times.at(index);
    if (elapsed === undefined) throw new Error(`Missing timing for ${name}`);
    rows.push(`  vs ${name}: ${(elapsed / baseline).toFixed(1)}x`);
  }
  return rows;
};
