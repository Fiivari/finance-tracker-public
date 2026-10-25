// Savings jar home screen widget for Scriptable (iOS). Shows how full this pay period's savings jar is, as on
// the dashboard, without any euro amounts. Run it once in the Scriptable app to save the endpoint address
// (widget/README.md); it's kept in the iOS Keychain, never in this file.

const KEY = "savings-jar-url";
const CACHE = FileManager.local().joinPath(FileManager.local().cacheDirectory(), "savings-jar.json");
const COLORS = {
  top: new Color("#0f2a22"),
  bottom: new Color("#07090d"),
  glass: new Color("#ffffff", 0.08),
  outline: new Color("#8a94a3"),
  level: new Color("#2cc28e"),
  potential: new Color("#9dcd67"),
  text: Color.white(),
};

if (!config.runsInWidget) await setUp();
const data = await load();
const widget = build(data);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();

async function setUp() {
  if (Keychain.contains(KEY)) {
    const menu = new Alert();
    menu.title = "Säästöpurkki";
    menu.addAction("Esikatsele");
    menu.addAction("Vaihda osoite");
    if ((await menu.presentSheet()) !== 1) return;
  }
  const ask = new Alert();
  ask.title = "Widgetin osoite";
  ask.message = "Liitä widget-projektin web app -osoite ja sen perään ?token=…";
  ask.addTextField("https://script.google.com/macros/s/…/exec?token=…", "");
  ask.addAction("Tallenna");
  ask.addCancelAction("Peruuta");
  if ((await ask.present()) === 0) Keychain.set(KEY, ask.textFieldValue(0).trim());
}

// Fresh levels from the endpoint, or the last ones that loaded (stale: true) when offline.
async function load() {
  const fm = FileManager.local();
  try {
    const text = await new Request(Keychain.get(KEY)).loadString();
    let res;
    try {
      res = JSON.parse(text);
    } catch (_) {
      // Google answers with an HTML page when the address isn't the /exec one, access isn't "Anyone" or the script failed.
      const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1];
      throw new Error(`Not JSON${title ? `: "${title}"` : ""}. Check the address ends in /exec and access is Anyone.`);
    }
    if (typeof res.level !== "number") throw new Error(res.error || "no data");
    fm.writeString(CACHE, JSON.stringify(res));
    return res;
  } catch (e) {
    if (!config.runsInWidget) console.error(e);
    return fm.fileExists(CACHE) ? { ...JSON.parse(fm.readString(CACHE)), stale: true } : null;
  }
}

function build(data) {
  const w = new ListWidget();
  const bg = new LinearGradient();
  bg.colors = [COLORS.top, COLORS.bottom];
  bg.locations = [0, 1];
  w.backgroundGradient = bg;
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  w.setPadding(12, 12, 12, 12);

  w.addSpacer();
  const img = w.addImage(drawJar(data ? data.level : 0, data ? data.potential ?? data.level : 0));
  img.imageSize = new Size(72, 90);
  img.centerAlignImage();
  w.addSpacer(8);

  const row = w.addStack();
  row.addSpacer();
  const full = data && data.level >= 1;
  const pct = row.addText(data ? `${full ? "✓ " : ""}${Math.round(data.level * 100)} %` : "–");
  pct.font = Font.boldRoundedSystemFont(22);
  pct.textColor = full ? COLORS.level : COLORS.text;
  if (data && data.stale) pct.textOpacity = 0.6;
  row.addSpacer();
  w.addSpacer();
  return w;
}

// The dashboard's jar (an SVG with a 72×90 viewBox), drawn at 3× for a sharp image.
function drawJar(level, potential) {
  const k = 3;
  const ctx = new DrawContext();
  ctx.size = new Size(72 * k, 90 * k);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const fill = (path, color) => {
    ctx.addPath(path);
    ctx.setFillColor(color);
    ctx.fillPath();
  };

  // Body: x 14–58, y 16–86, top corners radius 6, bottom corners radius 8.
  const [left, right, top, bottom, rt, rb] = [14, 58, 16, 86, 6, 8];
  const inset = (y) =>
    y < top + rt ? rt - Math.sqrt(rt * rt - (top + rt - y) ** 2) : y > bottom - rb ? rb - Math.sqrt(Math.max(0, rb * rb - (y - bottom + rb) ** 2)) : 0;
  // The jar's outline from height y0 down, as a polygon: so a level is the body cut off flat at its surface.
  const shape = (y0) => {
    const ys = [];
    for (let y = y0; y < bottom; y += 0.5) ys.push(y);
    ys.push(bottom);
    const path = new Path();
    path.addLines([...ys.map((y) => new Point((left + inset(y)) * k, y * k)), ...ys.reverse().map((y) => new Point((right - inset(y)) * k, y * k))]);
    path.closeSubpath();
    return path;
  };
  const levelAt = (share) => bottom - Math.min(1, Math.max(0, share)) * (bottom - top);

  const lid = new Path();
  lid.addRoundedRect(new Rect(22 * k, 6 * k, 28 * k, 8 * k), 3 * k, 3 * k);
  fill(lid, COLORS.outline);
  fill(shape(top), COLORS.glass);
  if (potential > level) fill(shape(levelAt(potential)), COLORS.potential);
  if (level > 0) fill(shape(levelAt(level)), COLORS.level);

  ctx.addPath(shape(top));
  ctx.setStrokeColor(COLORS.outline);
  ctx.setLineWidth(2 * k);
  ctx.strokePath();

  const shine = new Path();
  shine.addRoundedRect(new Rect(19.5 * k, 28 * k, 3 * k, 32 * k), 1.5 * k, 1.5 * k);
  fill(shine, new Color("#ffffff", 0.6));
  return ctx.getImage();
}
