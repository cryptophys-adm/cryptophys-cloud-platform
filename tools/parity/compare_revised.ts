// Before/after comparison of the legacy (mizan.ts) and revised (revised.ts) formulas on candle data
// exported from D1 as {SYMBOL: {score, vol1h, vol4h, h1: [closes asc], h4_desc: [closes desc],
// vols1h: [volumes asc], vols4h_desc: [volumes desc]}}. The revised router requires aligned per-candle
// volume windows; scalar latest-volume fallbacks are deliberately rejected because they hide volume behavior.
// Usage: node --experimental-strip-types tools/parity/compare_revised.ts prod.json
import { readFileSync } from "node:fs";
import { decision, mizan, regime, timeframeWeight } from "../../workers/signal-engine/src/mizan.ts";
import { decisionRevised, mizanSymbol, mizanTimeframe, regimeRevised } from "../../workers/signal-engine/src/revised.ts";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
  const s = d[sym];
  const h1: number[] = s.h1; const h4: number[] = [...s.h4_desc].reverse();
  const rOld = regime(h1)!; const rNew = regimeRevised(h1)!;
  const old1 = mizan(h1, s.vol1h, "1h", rOld, h1.at(-1)!, null) as any;
  const old4 = mizan(h4, s.vol4h, "4h", rOld, h4.at(-1)!, null) as any;
  const volumeSeries = (values: unknown, field: string, expected: number): number[] => {
    if (!Array.isArray(values) || values.length !== expected || !values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
      throw new Error(`${sym}: ${field} must contain ${expected} aligned finite, non-negative per-candle volumes; re-export the D1 window.`);
    }
    return values as number[];
  };
  const v1 = volumeSeries(s.vols1h, "vols1h", h1.length);
  const v4 = volumeSeries(s.vols4h_desc, "vols4h_desc", h4.length).reverse();
  const per = { "1h": mizanTimeframe(h1, v1, "1h"), "4h": mizanTimeframe(h4, v4, "4h") };
  const mNew = mizanSymbol(per, rNew, h1.at(-1)!, null)!;
  const dOld = decision(s.score); const dNew = decisionRevised(s.score);
  console.log(`\n${sym}  (1h n=${h1.length}, last close ${h1.at(-1)})`);
  console.log(`  regime  OLD: price-level entropy ${rOld.entropy} vs 0.92 -> score ${rOld.regime_score} (${rOld.regime_zone}), hurst ${rOld.hurst}`);
  console.log(`          NEW: return entropy ${rNew.entropy} vs calibrated ${rNew.entropy_max} (${rNew.calibration_windows} windows) -> score ${rNew.regime_score} (${rNew.regime_zone})`);
  console.log(`  KWW 1h  OLD close ${old1.kww_close} mom ${old1.kww_momentum} dir ${old1.trend_direction} | NEW close ${per["1h"].kww_close.toFixed(2)} mom ${per["1h"].kww_momentum.toFixed(4)} dir ${per["1h"].trend_direction}`);
  console.log(`  dim     OLD 1h ${old1.dim_score} 4h ${old4.dim_score} | NEW 1h ${per["1h"].dim_score.toFixed(4)} 4h ${per["4h"].dim_score.toFixed(4)}`);
  console.log(`  phi     OLD 1h ${old1.phi} (${old1.signal_tier}) 4h ${old4.phi} (${old4.signal_tier}) | NEW ${mNew.phi} (${mNew.signal_tier}, bias ${mNew.direction_bias}, signal ${mNew.signal})`);
  console.log(`  decision score ${s.score}: OLD ${dOld.action} (adj ${dOld.confluence_score}) | NEW ${dNew.action} (${dNew.bias}, conf ${dNew.confidence})`);
}
