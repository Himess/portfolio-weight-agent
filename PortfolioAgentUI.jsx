import React, { useState, useMemo } from "react";

/* ══════════════════════════════════════════════════════════════════════
   Portfolio Weight Agent
   Obsidian ground, ambient aurora, glass surfaces.
   Colour carries voice: the agent speaks violet, the market speaks warm.
   ══════════════════════════════════════════════════════════════════════ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

.pw{
  --bg:#07070C;
  --g1:rgba(255,255,255,.030); --g2:rgba(255,255,255,.048);
  --edge:rgba(255,255,255,.075); --edge2:rgba(255,255,255,.13);
  --tx:#F7F7FB; --tx2:#A3A5BC; --tx3:#666980;
  --up:#3DDC97; --dn:#FF6B6B; --warn:#FFA94D;
  --gold:#FFD166; --gold2:#F0932B;
  --ag:#A78BFA; --ag2:#7C5CFF;
  font-family:'Instrument Sans',system-ui,sans-serif;
  background:var(--bg); color:var(--tx); min-height:100vh;
  -webkit-font-smoothing:antialiased; letter-spacing:-0.014em;
  position:relative; overflow-x:hidden;
}
.pw *,.pw *::before,.pw *::after{box-sizing:border-box;}
.pw button{font:inherit;letter-spacing:inherit;cursor:pointer;border:none;background:none;color:inherit;}
.pw input{font:inherit;letter-spacing:inherit;}
.pw p{margin:0;}
.pw img{display:block;}
.pw .m{font-family:'JetBrains Mono',monospace;font-variant-numeric:tabular-nums;letter-spacing:-0.035em;}

/* ambient light */
.pw-aura{position:fixed;inset:0;pointer-events:none;z-index:0;}
.pw-aura i{position:absolute;display:block;border-radius:50%;filter:blur(90px);}
.pw-aura .a{width:760px;height:760px;top:-330px;left:-190px;background:rgba(124,92,255,.17);}
.pw-aura .b{width:620px;height:620px;top:180px;right:-250px;background:rgba(255,164,77,.085);}
.pw-aura .c{width:520px;height:520px;bottom:-260px;left:38%;background:rgba(61,220,151,.055);}

.pw-wrap{position:relative;z-index:1;max-width:1260px;margin:0 auto;padding:0 30px 110px;}

/* header */
.pw-hd{position:sticky;top:0;z-index:30;display:flex;justify-content:space-between;
  align-items:center;padding:17px 0 16px;margin-bottom:26px;
  backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border-bottom:1px solid rgba(255,255,255,.055);}
.pw-hd::before{content:"";position:absolute;inset:-1px -30px 0;background:rgba(7,7,12,.72);
  z-index:-1;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);}
.pw-br{display:flex;align-items:center;gap:12px;}
.pw-mk{width:33px;height:33px;border-radius:11px;flex:none;position:relative;
  background:linear-gradient(150deg,var(--gold),var(--gold2));
  box-shadow:0 4px 18px rgba(255,164,77,.30),inset 0 1px 0 rgba(255,255,255,.45);}
.pw-mk::after{content:"";position:absolute;inset:9px;border-radius:4px;
  border:2.2px solid rgba(7,7,12,.82);border-right-color:transparent;transform:rotate(45deg);}
.pw-nm{font-size:15px;font-weight:600;}
.pw-sb{font-size:12.5px;color:var(--tx3);margin-top:1px;}

.pw-live{display:inline-flex;align-items:center;gap:9px;padding:7px 14px;border-radius:99px;
  font-size:12.5px;color:var(--tx2);background:var(--g1);border:1px solid var(--edge);}
.pw-live i{width:6px;height:6px;border-radius:99px;background:var(--up);
  box-shadow:0 0 10px var(--up);animation:pwPulse 2.6s ease-in-out infinite;}
@keyframes pwPulse{0%,100%{opacity:1}50%{opacity:.32}}

/* nav */
.pw-nav{display:flex;gap:4px;padding:4px;background:var(--g1);border:1px solid var(--edge);
  border-radius:14px;margin-bottom:30px;width:fit-content;}
.pw-nav button{padding:9px 19px;border-radius:10px;font-size:13.5px;font-weight:500;
  color:var(--tx3);transition:.18s;}
.pw-nav button:hover{color:var(--tx2);}
.pw-nav button[data-on="1"]{background:var(--g2);color:var(--tx);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.09);}
.pw-nav .tk{color:var(--up);margin-right:7px;font-size:10px;}

/* glass card */
.pw-c{background:var(--g1);border:1px solid var(--edge);border-radius:22px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.055),0 18px 44px rgba(0,0,0,.34);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);}
.pw-p{padding:24px 26px;}

/* logo */
.pw-lg{position:relative;border-radius:99px;flex:none;overflow:hidden;
  width:36px;height:36px;background:var(--g2);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.09);}
.pw-lg img{width:100%;height:100%;object-fit:cover;}
.pw-lg.s{width:29px;height:29px;}
.pw-lg.l{width:44px;height:44px;}
.pw-fb{width:100%;height:100%;display:grid;place-items:center;color:#fff;
  font-weight:700;font-size:10.5px;letter-spacing:-0.04em;}
.pw-lg.s .pw-fb{font-size:9px;}

/* rows */
.pw-r{display:flex;align-items:center;gap:15px;padding:13px 17px;border-radius:15px;
  transition:background .16s;}
.pw-r:hover{background:var(--g1);}
.pw-r .rm{opacity:0;transition:.16s;color:var(--tx3);font-size:12.5px;padding:6px 10px;
  border-radius:8px;}
.pw-r:hover .rm{opacity:1;}
.pw-r .rm:hover{background:var(--g2);color:var(--dn);}

.pw-wt{display:flex;align-items:center;gap:3px;background:var(--g1);border:1px solid var(--edge);
  border-radius:11px;padding:0 12px 0 4px;transition:border-color .16s,background .16s;}
.pw-wt:focus-within{border-color:var(--edge2);background:var(--g2);}
.pw-wt input{width:50px;background:none;border:none;color:var(--tx);font-size:15px;
  font-weight:600;padding:9px 0;text-align:right;outline:none;}
.pw-wt em{color:var(--tx3);font-size:13px;font-style:normal;}

.pw-sl{-webkit-appearance:none;appearance:none;height:3px;border-radius:99px;
  background:rgba(255,255,255,.10);outline:none;}
.pw-sl::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:99px;
  background:#fff;cursor:grab;border:none;box-shadow:0 2px 8px rgba(0,0,0,.5);}
.pw-sl::-moz-range-thumb{width:14px;height:14px;border-radius:99px;background:#fff;
  cursor:grab;border:none;box-shadow:0 2px 8px rgba(0,0,0,.5);}

/* search + chips */
.pw-sr{display:flex;align-items:center;gap:11px;background:var(--g1);border:1px solid var(--edge);
  border-radius:14px;padding:13px 16px;transition:.16s;}
.pw-sr:focus-within{border-color:var(--edge2);background:var(--g2);}
.pw-sr input{flex:1;min-width:0;background:none;border:none;outline:none;color:var(--tx);font-size:14px;}
.pw-sr input::placeholder{color:var(--tx3);}

.pw-ch{display:flex;gap:6px;overflow-x:auto;padding:15px 0 3px;scrollbar-width:none;}
.pw-ch::-webkit-scrollbar{display:none;}
.pw-ch button{padding:7px 14px;border-radius:99px;font-size:12.5px;font-weight:500;
  white-space:nowrap;background:var(--g1);color:var(--tx2);
  border:1px solid transparent;transition:.16s;}
.pw-ch button:hover{background:var(--g2);color:var(--tx);}
.pw-ch button[data-on="1"]{background:var(--tx);color:var(--bg);font-weight:600;}

.pw-ls{max-height:426px;overflow-y:auto;margin:10px -8px 0;padding:0 8px;}
.pw-tk{display:flex;align-items:center;gap:13px;width:100%;padding:10px 12px;border-radius:14px;
  text-align:left;transition:background .15s;}
.pw-tk:hover{background:var(--g1);}
.pw-tk .ad{width:28px;height:28px;border-radius:9px;background:var(--g2);color:var(--tx2);
  display:grid;place-items:center;font-size:16px;font-weight:500;flex:none;transition:.16s;}
.pw-tk:hover .ad{background:linear-gradient(150deg,var(--gold),var(--gold2));color:#07070C;
  box-shadow:0 3px 14px rgba(255,164,77,.34);}
.pw-tk[data-in="1"]{opacity:.3;pointer-events:none;}

.pw-hero{font-size:78px;font-weight:600;line-height:.92;letter-spacing:-0.055em;
  background:linear-gradient(170deg,#fff 8%,var(--warn) 96%);
  -webkit-background-clip:text;background-clip:text;color:transparent;}

/* deviation meter */
.pw-dv{position:relative;height:34px;}
.pw-dv .bd{position:absolute;top:12px;height:11px;border-radius:4px;
  background:rgba(255,255,255,.055);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05);}
.pw-dv .ax{position:absolute;top:5px;bottom:5px;width:1px;left:50%;
  background:rgba(255,255,255,.22);}
.pw-dv .fl{position:absolute;top:14px;height:7px;border-radius:99px;opacity:.42;
  transition:all .4s cubic-bezier(.4,0,.2,1);}
.pw-dv .pn{position:absolute;top:8px;height:19px;width:3px;border-radius:99px;
  transition:left .4s cubic-bezier(.4,0,.2,1);}

/* buttons */
.pw-go{position:relative;border-radius:14px;padding:14px 28px;font-size:14.5px;font-weight:600;
  color:#07070C;background:linear-gradient(150deg,var(--gold),var(--gold2));
  box-shadow:0 8px 26px rgba(255,164,77,.26),inset 0 1px 0 rgba(255,255,255,.42);
  transition:transform .13s,box-shadow .18s,filter .18s;}
.pw-go:hover{filter:brightness(1.06);box-shadow:0 12px 34px rgba(255,164,77,.36),
  inset 0 1px 0 rgba(255,255,255,.45);}
.pw-go:active{transform:translateY(1px);}
.pw-go:disabled{background:var(--g1);color:var(--tx3);box-shadow:none;cursor:not-allowed;
  filter:none;transform:none;border:1px solid var(--edge);}
.pw-gh{background:var(--g1);border:1px solid var(--edge);color:var(--tx);border-radius:14px;
  padding:14px 24px;font-size:14.5px;font-weight:500;transition:.16s;}
.pw-gh:hover{background:var(--g2);border-color:var(--edge2);}

.pw-sg{display:inline-flex;background:var(--g1);border:1px solid var(--edge);
  border-radius:12px;padding:4px;}
.pw-sg button{padding:8px 17px;border-radius:9px;font-size:13px;font-weight:500;
  color:var(--tx3);transition:.16s;}
.pw-sg button[data-on="1"]{background:var(--g2);color:var(--tx);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.09);}

.pw-op{display:block;width:100%;text-align:left;padding:12px 14px;border-radius:13px;
  border:1px solid transparent;transition:.16s;}
.pw-op:hover{background:var(--g1);}
.pw-op[data-on="1"]{background:var(--g2);border-color:var(--edge2);}

/* the agent's voice */
.pw-say{position:relative;padding:22px 26px 22px 27px;border-radius:20px;
  background:linear-gradient(135deg,rgba(124,92,255,.13),rgba(124,92,255,.035));
  border:1px solid rgba(167,139,250,.22);}
.pw-say::before{content:"";position:absolute;left:0;top:20px;bottom:20px;width:2px;
  border-radius:99px;background:linear-gradient(var(--ag),transparent);}
.pw-tag{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ag);
  margin-bottom:11px;}
.pw-tag i{width:5px;height:5px;border-radius:99px;background:var(--ag);
  box-shadow:0 0 9px var(--ag);}

.pw-sc{scrollbar-width:thin;}
.pw ::-webkit-scrollbar{width:9px;height:9px;}
.pw ::-webkit-scrollbar-track{background:transparent;}
.pw ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.10);border-radius:9px;
  border:2px solid transparent;background-clip:padding-box;}
.pw ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.19);background-clip:padding-box;}
.pw :focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:6px;}

@keyframes pwUp{from{opacity:0;transform:translateY(11px)}to{opacity:1;transform:none}}
.pw-in{animation:pwUp .5s cubic-bezier(.22,1,.36,1) both;}

.pw-g1{display:grid;grid-template-columns:minmax(0,1fr) 384px;gap:22px;}
.pw-g2{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:24px;}
.pw-g3{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:18px;}
@media(max-width:1100px){.pw-g1,.pw-g2,.pw-g3{grid-template-columns:minmax(0,1fr);}}
@media(prefers-reduced-motion:reduce){.pw *{animation:none!important;transition:none!important;}}
`;

/* ─────────── universe ─────────── */
const TOKENS = [
  ["BTC","Bitcoin","#F7931A",112480,1.4,["l1"]],
  ["ETH","Ethereum","#627EEA",3721,2.8,["l1"]],
  ["SOL","Solana","#14B87F",214.6,-1.2,["l1"]],
  ["AVAX","Avalanche","#E84142",5.03,-4.6,["l1"]],
  ["BNB","BNB","#F0B90B",892.4,0.7,["l1"]],
  ["SUI","Sui","#4DA2FF",3.42,5.1,["l1"]],
  ["APT","Aptos","#22D3EE",7.18,-2.4,["l1"]],
  ["NEAR","NEAR Protocol","#7C8CF8",4.02,1.9,["l1","ai"]],
  ["SEI","Sei","#B02C24",0.41,-3.1,["l1"]],
  ["TIA","Celestia","#7B2BF9",4.87,6.3,["l1"]],
  ["ADA","Cardano","#0F62FE",0.72,-0.4,["l1"]],
  ["DOT","Polkadot","#E6007A",4.61,0.9,["l1"]],
  ["ATOM","Cosmos","#5B67D8",4.94,-1.8,["l1"]],
  ["XRP","XRP","#7A8290",2.41,0.6,["l1"]],
  ["LTC","Litecoin","#345D9D",92.4,-0.9,["l1"]],
  ["ARB","Arbitrum","#28A0F0",0.58,3.4,["l2"]],
  ["OP","Optimism","#FF3B47",1.24,2.1,["l2"]],
  ["STRK","Starknet","#EC796B",0.29,-5.2,["l2"]],
  ["MATIC","Polygon","#8247E5",0.39,-1.7,["l2"]],
  ["LINK","Chainlink","#2A5ADA",21.4,1.6,["defi"]],
  ["UNI","Uniswap","#FF007A",9.87,-2.2,["defi"]],
  ["AAVE","Aave","#B6509E",284.1,4.4,["defi"]],
  ["MKR","Sky","#1AAB9B",1642,0.3,["defi"]],
  ["LDO","Lido DAO","#22A0F0",1.34,-1.1,["defi","stake"]],
  ["ENA","Ethena","#9098A8",0.51,7.8,["defi"]],
  ["ONDO","Ondo","#3B82F6",0.94,2.6,["defi"]],
  ["JUP","Jupiter","#2AC5B8",0.88,-0.8,["defi"]],
  ["PYTH","Pyth Network","#7142CF",0.24,1.2,["defi"]],
  ["INJ","Injective","#00A6D6",22.6,-3.5,["l1","defi"]],
  ["RPL","Rocket Pool","#FF7B4D",8.62,1.1,["stake"]],
  ["TAO","Bittensor","#0EA5A0",412.8,8.2,["ai"]],
  ["RNDR","Render","#FF5C1C",4.31,5.7,["ai"]],
  ["FET","Artificial Superintelligence","#6366F1",1.18,4.1,["ai"]],
  ["GRT","The Graph","#6747ED",0.13,-1.4,["ai"]],
  ["DOGE","Dogecoin","#C2A633",0.22,-2.9,["meme"]],
  ["WIF","dogwifhat","#B98CE8",1.87,-6.4,["meme"]],
  ["PEPE","Pepe","#4CAF50",0.000012,-4.2,["meme"]],
  ["USDT","Tether","#26A17B",1,0,["cash"]],
  ["USDC","USD Coin","#2775CA",1,0,["cash"]],
];
const BY = Object.fromEntries(TOKENS.map(t => [t[0], t]));
const CATS = [["all","All"],["l1","Layer 1"],["l2","Layer 2"],["defi","DeFi"],
  ["ai","AI"],["stake","Staking"],["meme","Memes"],["cash","Stablecoins"]];

const usd = (n, d = 0) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits:d, maximumFractionDigits:d });
const px = (p) => p >= 100 ? usd(p) : p >= 1 ? usd(p, 2) : p >= 0.01 ? usd(p, 3) : "$" + p.toFixed(6);
const pp = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : "") + Math.abs(n).toFixed(1) + "pp";

/* real token logo, monogram fallback */
function Logo({ sym, size }) {
  const [bad, setBad] = useState(false);
  const c = BY[sym]?.[2] || "#666980";
  return (
    <div className={"pw-lg" + (size ? " " + size : "")}>
      {bad ? (
        <div className="pw-fb" style={{ background:`linear-gradient(148deg,${c},${c}88)` }}>
          {sym.length > 4 ? sym.slice(0, 3) : sym}
        </div>
      ) : (
        <img alt="" loading="lazy" onError={() => setBad(true)}
          src={`https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`}/>
      )}
    </div>
  );
}

/* deterministic sparkline */
function Spark({ sym, up }) {
  const d = useMemo(() => {
    let s = 0; for (let i = 0; i < sym.length; i++) s = (s * 31 + sym.charCodeAt(i)) % 9973;
    const n = 22, pts = [];
    let v = 50;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      v += ((s / 2147483648) - 0.5) * 17 + (up ? 1.5 : -1.5);
      v = Math.max(8, Math.min(92, v));
      pts.push(`${(i / (n - 1)) * 56},${32 - (v / 100) * 26}`);
    }
    return pts.join(" ");
  }, [sym, up]);
  return (
    <svg width="56" height="32" style={{ flex:"none", opacity:.85 }} aria-hidden="true">
      <polyline points={d} fill="none" strokeWidth="1.6" strokeLinecap="round"
        strokeLinejoin="round" stroke={up ? "var(--up)" : "var(--dn)"}/>
    </svg>
  );
}

/* allocation ring */
function Ring({ rows, total }) {
  const R = 54, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ position:"relative", width:140, height:140, flex:"none" }}>
      <svg width="140" height="140" style={{ transform:"rotate(-90deg)" }}>
        <circle cx="70" cy="70" r={R} fill="none" strokeWidth="15"
          stroke="rgba(255,255,255,.05)"/>
        {rows.map(r => {
          const w = Math.max(+r.w || 0, 0);
          const len = (w / Math.max(total, 100)) * C;
          const off = acc; acc += len;
          return (
            <circle key={r.sym} cx="70" cy="70" r={R} fill="none" strokeWidth="15"
              stroke={BY[r.sym]?.[2] || "#666980"} strokeLinecap="butt"
              strokeDasharray={`${Math.max(len - 2.5, 0)} ${C}`}
              strokeDashoffset={-off}
              style={{ transition:"stroke-dasharray .45s cubic-bezier(.4,0,.2,1), stroke-dashoffset .45s cubic-bezier(.4,0,.2,1)" }}/>
          );
        })}
      </svg>
      <div style={{ position:"absolute", inset:0, display:"grid", placeItems:"center" }}>
        <div style={{ textAlign:"center" }}>
          <div className="m" style={{ fontSize:25, fontWeight:600, letterSpacing:"-0.05em",
            color: Math.abs(total - 100) < 0.05 ? "var(--tx)" : "var(--warn)" }}>
            {total.toFixed(0)}%
          </div>
          <div style={{ fontSize:11, color:"var(--tx3)", marginTop:1 }}>allocated</div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ 1 · BUILD ═══════════ */
function Build({ go }) {
  const [title, setTitle] = useState("Long-horizon core");
  const [rows, setRows] = useState([
    { sym:"BTC", w:40 }, { sym:"ETH", w:20 },
    { sym:"SOL", w:15 }, { sym:"AVAX", w:15 }, { sym:"USDT", w:10 },
  ]);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [track, setTrack] = useState(1);

  const total = rows.reduce((s, r) => s + (+r.w || 0), 0);
  const ok = Math.abs(total - 100) < 0.05;
  const held = new Set(rows.map(r => r.sym));

  const list = useMemo(() => {
    const s = q.trim().toUpperCase();
    return TOKENS.filter(([sym, nm, , , , t]) =>
      (cat === "all" || t.includes(cat)) &&
      (!s || sym.includes(s) || nm.toUpperCase().includes(s)));
  }, [q, cat]);

  const setW = (sym, v) =>
    setRows(r => r.map(x => x.sym === sym ? { ...x, w: v === "" ? "" : +v } : x));

  return (
    <div className="pw-g1 pw-in">
      <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
        <div className="pw-c pw-p" style={{ display:"flex", gap:30, alignItems:"center" }}>
          <Ring rows={rows} total={total}/>
          <div style={{ flex:1, minWidth:0 }}>
            <input value={title} onChange={e => setTitle(e.target.value)}
              aria-label="Portfolio name"
              style={{ background:"none", border:"none", outline:"none", color:"var(--tx)",
                fontSize:29, fontWeight:600, width:"100%", letterSpacing:"-0.045em", padding:0 }}/>
            <div style={{ color:"var(--tx3)", fontSize:13.5, marginTop:6 }}>
              {rows.length} assets · {["Patient","Balanced","Tight"][track].toLowerCase()} tracking
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:"9px 18px", marginTop:18 }}>
              {rows.map(r => (
                <div key={r.sym} style={{ display:"flex", alignItems:"center", gap:8,
                  fontSize:12.5, color:"var(--tx2)" }}>
                  <i style={{ width:8, height:8, borderRadius:3, display:"block",
                    background:BY[r.sym]?.[2], boxShadow:`0 0 9px ${BY[r.sym]?.[2]}66` }}/>
                  <span style={{ color:"var(--tx)", fontWeight:500 }}>{r.sym}</span>
                  <span className="m">{(+r.w || 0).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pw-c" style={{ padding:"11px 9px" }}>
          {rows.map(r => (
            <div key={r.sym} className="pw-r">
              <Logo sym={r.sym}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14.5, fontWeight:600 }}>{BY[r.sym]?.[1] || r.sym}</div>
                <div className="m" style={{ fontSize:12.5, color:"var(--tx3)", marginTop:2 }}>
                  {r.sym} · {px(BY[r.sym]?.[3] || 0)}
                </div>
              </div>
              <input type="range" className="pw-sl" min="0" max="100" step="0.5"
                aria-label={`${r.sym} weight`} style={{ width:132 }}
                value={+r.w || 0} onChange={e => setW(r.sym, e.target.value)}/>
              <div className="pw-wt">
                <input value={r.w} inputMode="decimal" aria-label={`${r.sym} percent`}
                  onChange={e => setW(r.sym, e.target.value.replace(/[^\d.]/g, ""))}/>
                <em>%</em>
              </div>
              <button className="rm" onClick={() => setRows(x => x.filter(y => y.sym !== r.sym))}>
                Remove
              </button>
            </div>
          ))}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
            gap:12, padding:"17px 17px 9px", marginTop:9,
            borderTop:"1px solid rgba(255,255,255,.055)" }}>
            <div className="pw-ch" style={{ padding:0 }}>
              <button onClick={() => setRows(r =>
                r.map(x => ({ ...x, w:+(100/r.length).toFixed(1) })))}>Split evenly</button>
              {!ok && total > 0 && (
                <button style={{ color:"var(--warn)" }} onClick={() => setRows(r =>
                  r.map(x => ({ ...x, w:+((x.w/total)*100).toFixed(1) })))}>Scale to 100%</button>
              )}
            </div>
            <div style={{ display:"flex", alignItems:"baseline", gap:10, flex:"none" }}>
              <span style={{ color:"var(--tx3)", fontSize:13 }}>Allocated</span>
              <span className="m" style={{ fontSize:19, fontWeight:600,
                color: ok ? "var(--up)" : "var(--warn)" }}>{total.toFixed(1)}%</span>
            </div>
          </div>
        </div>

        <div className="pw-c pw-p">
          <div style={{ fontSize:14.5, fontWeight:600 }}>How closely should it track?</div>
          <p style={{ fontSize:13, color:"var(--tx3)", margin:"6px 0 15px", maxWidth:"58ch" }}>
            Wider tolerance means fewer trades and less cost, at the price of drifting further
            from your targets between corrections.
          </p>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10 }}>
            {[["Patient","Acts rarely"],["Balanced","Recommended"],["Tight","Stays close"]]
              .map(([k, d], i) => (
              <button key={k} className="pw-op" data-on={track === i ? 1 : 0}
                onClick={() => setTrack(i)}>
                <div style={{ fontSize:14, fontWeight:600 }}>{k}</div>
                <div style={{ fontSize:12, color:"var(--tx3)", marginTop:3 }}>{d}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* picker */}
      <div style={{ display:"flex", flexDirection:"column", gap:14,
        position:"sticky", top:96, alignSelf:"start" }}>
        <div className="pw-c pw-p">
          <div className="pw-sr">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--tx3)"
              strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>
            </svg>
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search any token on Binance" aria-label="Search tokens"/>
            {q && <button onClick={() => setQ("")} aria-label="Clear"
              style={{ color:"var(--tx3)", fontSize:18, lineHeight:1 }}>×</button>}
          </div>

          <div className="pw-ch">
            {CATS.map(([k, l]) => (
              <button key={k} data-on={cat === k ? 1 : 0} onClick={() => setCat(k)}>{l}</button>
            ))}
          </div>

          <div className="pw-ls">
            {list.length === 0 ? (
              <div style={{ padding:"46px 14px", textAlign:"center" }}>
                <div style={{ fontSize:14.5, fontWeight:600 }}>Nothing matches “{q}”</div>
                <div style={{ fontSize:13, color:"var(--tx3)", marginTop:7 }}>
                  Try the ticker, or switch category.
                </div>
              </div>
            ) : list.map(([sym, nm, , p, ch]) => (
              <button key={sym} className="pw-tk" data-in={held.has(sym) ? 1 : 0}
                onClick={() => setRows(r => [...r, { sym, w:0 }])}>
                <Logo sym={sym} size="s"/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13.5, fontWeight:600 }}>{sym}</div>
                  <div style={{ fontSize:12, color:"var(--tx3)", marginTop:1, overflow:"hidden",
                    textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{nm}</div>
                </div>
                {ch !== 0 && <Spark sym={sym} up={ch > 0}/>}
                <div style={{ textAlign:"right", minWidth:64 }}>
                  <div className="m" style={{ fontSize:12.5 }}>{px(p)}</div>
                  <div className="m" style={{ fontSize:11.5, marginTop:3,
                    color: ch > 0 ? "var(--up)" : ch < 0 ? "var(--dn)" : "var(--tx3)" }}>
                    {ch > 0 ? "+" : ""}{ch.toFixed(1)}%
                  </div>
                </div>
                <div className="ad">{held.has(sym) ? "✓" : "+"}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="pw-c pw-p">
          <div style={{ fontSize:14, fontWeight:600 }}>Add a whole theme</div>
          <p style={{ fontSize:12.5, color:"var(--tx3)", margin:"6px 0 13px" }}>
            Describe it however you think about it. The agent picks the tradable symbols and
            shows you why before anything is saved.
          </p>
          <div className="pw-sr">
            <input placeholder="Restaking, RWA, Solana DeFi…" aria-label="Theme"/>
            <button style={{ color:"var(--gold)", fontSize:13, fontWeight:600 }}>Resolve</button>
          </div>
        </div>

        <button className="pw-go" disabled={!ok} onClick={() => go(1)} style={{ padding:"16px 0" }}>
          {ok ? "Review my portfolio"
              : total > 100 ? `${(total - 100).toFixed(1)}% over`
              : `${(100 - total).toFixed(1)}% left to allocate`}
        </button>
      </div>
    </div>
  );
}

/* ═══════════ 2 · PORTFOLIO ═══════════ */
const NAV = 62732;
const POS = [
  { sym:"BTC",  tgt:40, cur:39.1, val:24528, band:10.0 },
  { sym:"ETH",  tgt:20, cur:26.4, val:16561, band:5.0  },
  { sym:"SOL",  tgt:15, cur:14.2, val:8908,  band:3.8  },
  { sym:"AVAX", tgt:15, cur:10.5, val:6587,  band:3.8  },
  { sym:"USDT", tgt:10, cur:9.8,  val:6148,  band:2.5  },
];

const Dev = ({ d, band, scale = 12 }) => {
  const at = (v) => 50 + (v / scale) * 50;
  const c = Math.abs(d) > band ? "var(--warn)" : "var(--up)";
  return (
    <div className="pw-dv">
      <div className="bd" style={{ left:`${at(-band)}%`, width:`${at(band) - at(-band)}%` }}/>
      <div className="ax"/>
      <div className="fl" style={{ left:`${Math.min(50, at(d))}%`,
        width:`${Math.abs(at(d) - 50)}%`, background:c }}/>
      <div className="pn" style={{ left:`calc(${at(d)}% - 1.5px)`, background:c,
        boxShadow:`0 0 12px ${Math.abs(d) > band ? "rgba(255,169,77,.75)" : "rgba(61,220,151,.7)"}` }}/>
    </div>
  );
};

function Portfolio({ go }) {
  const rows = POS.map(p => ({ ...p, d:p.cur - p.tgt }));
  const total = rows.reduce((s, r) => s + Math.abs(r.d), 0) / 2;
  const out = rows.filter(r => Math.abs(r.d) > r.band);

  return (
    <div className="pw-in" style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div className="pw-g3">
        <div className="pw-c pw-p">
          <div style={{ fontSize:13, color:"var(--tx3)" }}>Distance from target</div>
          <div className="m pw-hero" style={{ marginTop:10 }}>
            {total.toFixed(1)}<span style={{ fontSize:30, marginLeft:3 }}>pp</span>
          </div>
          <p style={{ fontSize:13, color:"var(--tx2)", marginTop:14, maxWidth:"36ch" }}>
            The share of the portfolio that would change hands to get back on target.
          </p>
        </div>
        <div className="pw-c pw-p">
          <div style={{ fontSize:13, color:"var(--tx3)" }}>Portfolio value</div>
          <div className="m" style={{ fontSize:31, fontWeight:600, marginTop:10,
            letterSpacing:"-0.05em" }}>{usd(NAV)}</div>
          <div className="m" style={{ fontSize:13, color:"var(--up)", marginTop:9 }}>
            +$1,847 today
          </div>
        </div>
        <div className="pw-c pw-p">
          <div style={{ fontSize:13, color:"var(--tx3)" }}>Outside tolerance</div>
          <div className="m" style={{ fontSize:31, fontWeight:600, marginTop:10,
            letterSpacing:"-0.05em" }}>
            {out.length}<span style={{ fontSize:17, color:"var(--tx3)" }}> of {rows.length}</span>
          </div>
          <div style={{ display:"flex", gap:7, marginTop:12 }}>
            {out.map(o => <Logo key={o.sym} sym={o.sym} size="s"/>)}
          </div>
        </div>
      </div>

      <div className="pw-c" style={{ padding:"7px 9px 11px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"290px 1fr 124px", gap:20,
          padding:"15px 17px 13px", fontSize:12, color:"var(--tx3)" }}>
          <div>Position</div>
          <div style={{ textAlign:"center" }}>under target · on target · over target</div>
          <div style={{ textAlign:"right" }}>Deviation</div>
        </div>
        {rows.map(r => {
          const isOut = Math.abs(r.d) > r.band;
          return (
            <div key={r.sym} className="pw-r"
              style={{ display:"grid", gridTemplateColumns:"290px 1fr 124px", gap:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <Logo sym={r.sym}/>
                <div>
                  <div style={{ fontSize:14.5, fontWeight:600 }}>{BY[r.sym]?.[1]}</div>
                  <div className="m" style={{ fontSize:12.5, color:"var(--tx3)", marginTop:2 }}>
                    {r.cur.toFixed(1)}% of {r.tgt}% · {usd(r.val)}
                  </div>
                </div>
              </div>
              <Dev d={r.d} band={r.band}/>
              <div style={{ textAlign:"right" }}>
                <div className="m" style={{ fontSize:16, fontWeight:600,
                  color: isOut ? "var(--warn)" : "var(--tx2)" }}>{pp(r.d)}</div>
                <div style={{ fontSize:11.5, color:"var(--tx3)", marginTop:3 }}>
                  {isOut ? "outside" : "within"} ±{r.band}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display:"flex", gap:11 }}>
        <button className="pw-go" onClick={() => go(2)}>See what the agent decided</button>
        <button className="pw-gh" onClick={() => go(0)}>Change my targets</button>
      </div>
    </div>
  );
}

/* ═══════════ 3 · PROPOSAL ═══════════ */
const TRADES = [
  { side:"Sell", sym:"ETH",  qty:"1.08", usd:4015, slip:"0.0",
    why:"Deepest book of the three, and it funds the buys — so it goes first." },
  { side:"Buy",  sym:"AVAX", qty:"561",  usd:2823, slip:"2.0",
    why:"Furthest below target. Thinner book, so a limit order resting at mid." },
  { side:"Buy",  sym:"SOL",  qty:"5.4",  usd:502,  slip:"0.4",
    why:"Small top-up so the two Layer 1s stay evenly split." },
];

const N = ({ children }) => (
  <b className="m" style={{ color:"var(--tx)", fontWeight:600 }}>{children}</b>
);

const Say = ({ line, children }) => (
  <div className="pw-say">
    <div className="pw-tag"><i/> The agent's call</div>
    <div style={{ fontSize:25, fontWeight:600, lineHeight:1.3, letterSpacing:"-0.04em",
      maxWidth:"26ch", marginBottom:15 }}>{line}</div>
    <p style={{ fontSize:14.5, lineHeight:1.75, color:"var(--tx2)", maxWidth:"60ch" }}>
      {children}
    </p>
  </div>
);

const Stat = ({ title, note, rows }) => (
  <div className="pw-c pw-p">
    <div style={{ fontSize:14, fontWeight:600 }}>{title}</div>
    {note && <p style={{ fontSize:12, color:"var(--tx3)", margin:"6px 0 10px" }}>{note}</p>}
    <div style={{ marginTop: note ? 0 : 13 }}>
      {rows.map(([k, v, c]) => (
        <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"9px 0",
          fontSize:13.5, borderBottom:"1px solid rgba(255,255,255,.05)" }}>
          <span style={{ color:"var(--tx3)" }}>{k}</span>
          <span className="m" style={{ fontWeight:600, color:c || "var(--tx)" }}>{v}</span>
        </div>
      ))}
    </div>
  </div>
);

function Proposal({ go }) {
  const [hold, setHold] = useState(false);
  return (
    <div className="pw-in">
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
        marginBottom:22, flexWrap:"wrap", gap:10 }}>
        <span style={{ fontSize:12.5, color:"var(--tx3)" }}>
          Both states are real agent output from the replay run
        </span>
        <div className="pw-sg">
          {[["Rebalance", false], ["Hold", true]].map(([l, v]) => (
            <button key={l} data-on={hold === v ? 1 : 0} onClick={() => setHold(v)}>{l}</button>
          ))}
        </div>
      </div>
      {hold ? <Hold/> : <Rebalance go={go}/>}
    </div>
  );
}

function Rebalance({ go }) {
  return (
    <div className="pw-g2">
      <div>
        <Say line="Trim the winner, top up the laggard.">
          You are <N>6.4pp</N> from target with two positions outside tolerance. ETH has run
          to <N>26.4%</N> of a 20% target while AVAX has slipped to <N>10.5%</N> of 15%.
          Volatility is unremarkable and the books are deep enough that correcting this
          costs <N>$5.67</N> — roughly a dollar per point of drift removed. Worth doing today.
        </Say>

        <div className="pw-c" style={{ padding:"9px 9px 11px", marginTop:20 }}>
          {TRADES.map((t, i) => (
            <div key={t.sym} className="pw-r" style={{ alignItems:"flex-start" }}>
              <div className="m" style={{ width:13, color:"var(--tx3)", fontSize:12.5,
                paddingTop:10, flex:"none" }}>{i + 1}</div>
              <div style={{ paddingTop:2 }}><Logo sym={t.sym}/></div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:600 }}>
                  <span style={{ color: t.side === "Sell" ? "var(--warn)" : "var(--up)" }}>
                    {t.side}</span>{" "}
                  <span className="m">{t.qty}</span> {t.sym}
                </div>
                <div style={{ fontSize:13, color:"var(--tx3)", marginTop:5, maxWidth:"50ch" }}>
                  {t.why}
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div className="m" style={{ fontSize:15, fontWeight:600 }}>{usd(t.usd)}</div>
                <div className="m" style={{ fontSize:11.5, color:"var(--tx3)", marginTop:4 }}>
                  {t.slip} bps slip
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display:"flex", gap:11, marginTop:22, alignItems:"center", flexWrap:"wrap" }}>
          <button className="pw-go" onClick={() => go(3)}>Send these to Binance</button>
          <button className="pw-gh">Not today</button>
          <span style={{ fontSize:12.5, color:"var(--tx3)", maxWidth:"26ch" }}>
            Each order opens in Binance for your confirmation.
          </span>
        </div>
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
        <Stat title="What this costs you" rows={[
          ["Traded", usd(7340)], ["Fees and slippage", "$5.67"],
          ["Drift afterwards", "1.1pp", "var(--up)"], ["Cost per point", "$1.07"]]}/>
        <Stat title="What the agent looked at"
          note="Every figure computed in code, none written by the model."
          rows={[["ETH deviation", "+6.4pp", "var(--warn)"],
            ["AVAX deviation", "\u22124.5pp", "var(--warn)"],
            ["Volatility ratio", "0.94"], ["Book depth", "sufficient"]]}/>
      </div>
    </div>
  );
}

function Hold() {
  return (
    <div className="pw-g2">
      <div>
        <Say line="Nothing today. The move is still running.">
          AVAX sits <N>4.9pp</N> above target against a tolerance of <N>3.8pp</N>, so it has
          crossed the line. But it is up <N>3.2%</N> in four hours and <N>9.9%</N> over the day,
          with volatility running <N>1.9×</N> its recent level. Selling into a climb this fast
          is a guess about the top, not a rebalance. The drift is worth carrying for now.
        </Say>

        <div style={{ marginTop:30 }}>
          <div style={{ fontSize:14.5, fontWeight:600 }}>What a threshold bot would have done</div>
          <p style={{ fontSize:13, color:"var(--tx3)", margin:"6px 0 15px", maxWidth:"56ch" }}>
            The trade was sized, priced and ready to send. The band was breached, so a rule
            would have fired. The agent read the same numbers and declined.
          </p>
          <div className="pw-c" style={{ padding:"18px 22px", borderStyle:"dashed",
            boxShadow:"none", background:"rgba(255,255,255,.016)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:14, opacity:.34 }}>
              <Logo sym="AVAX"/>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:600, textDecoration:"line-through" }}>
                  <span style={{ color:"var(--warn)" }}>Sell</span>{" "}
                  <span className="m">412</span> AVAX
                </div>
                <div style={{ fontSize:12.5, color:"var(--tx3)", marginTop:4 }}>
                  Market order · would have filled immediately
                </div>
              </div>
              <div className="m" style={{ fontSize:15, fontWeight:600,
                textDecoration:"line-through" }}>$2,240</div>
            </div>
            <div style={{ marginTop:16, paddingTop:15, fontSize:13, color:"var(--up)",
              display:"flex", alignItems:"center", gap:9,
              borderTop:"1px solid rgba(255,255,255,.06)" }}>
              <span style={{ fontSize:11 }}>✕</span> Rejected — selling into an active climb
            </div>
          </div>
        </div>

        <div style={{ display:"flex", gap:11, marginTop:24, alignItems:"center" }}>
          <button className="pw-gh">Check again later</button>
          <button style={{ color:"var(--tx3)", fontSize:13.5, textDecoration:"underline",
            textUnderlineOffset:4 }}>Rebalance anyway</button>
        </div>
      </div>

      <div>
        <Stat title="What the agent looked at"
          note="Every figure computed in code, none written by the model."
          rows={[["AVAX deviation", "+4.9pp", "var(--warn)"], ["Its tolerance", "3.8pp"],
            ["4-hour move", "+3.2%", "var(--up)"], ["24-hour move", "+9.9%", "var(--up)"],
            ["Volatility ratio", "1.93", "var(--warn)"], ["Trades rejected", "1"]]}/>
      </div>
    </div>
  );
}

/* ═══════════ shell ═══════════ */
const STEPS = ["Build", "Portfolio", "Proposal", "Handoff"];

export default function App() {
  const [step, setStep] = useState(0);
  return (
    <div className="pw">
      <style>{CSS}</style>
      <div className="pw-aura"><i className="a"/><i className="b"/><i className="c"/></div>

      <div className="pw-wrap">
        <div className="pw-hd">
          <div className="pw-br">
            <div className="pw-mk"/>
            <div>
              <div className="pw-nm">Portfolio Weight Agent</div>
              <div className="pw-sb">Selling winners and buying losers, on your approval</div>
            </div>
          </div>
          <div className="pw-live"><i/> Judgment layer live</div>
        </div>

        <div className="pw-nav">
          {STEPS.map((s, i) => (
            <button key={s} data-on={i === step ? 1 : 0} onClick={() => setStep(i)}>
              {i < step && <span className="tk">✓</span>}{s}
            </button>
          ))}
        </div>

        {step === 0 && <Build go={setStep}/>}
        {step === 1 && <Portfolio go={setStep}/>}
        {step === 2 && <Proposal go={setStep}/>}
        {step === 3 && (
          <div className="pw-in" style={{ maxWidth:660 }}>
            <Say line="Three orders are waiting for you.">
              Each opens in Binance for your confirmation, in the order shown. Between orders
              the agent rechecks that the next leg still makes sense at the current price. If
              the picture has changed materially it stops and re-plans rather than pushing the
              rest through.
            </Say>
          </div>
        )}
      </div>
    </div>
  );
}
