// Converte valores px -> rem em arquivos CSS.
// Regras:
//   - 1px e 2px ficam em px (bordas finas / outlines / sombras sutis)
//   - box-shadow, text-shadow, outline mantêm px (sombras e contornos)
//   - 0px vira 0 (sem unidade)
//   - demais px -> rem (dividido por 16)
//   - media queries: px -> em (dividido por 16)
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "css/style.css",
  "css/dice.css",
];

function pxToRem(match, num) {
  const n = parseFloat(num);
  if (n === 0) return "0";
  if (n === 1 || n === 2) return match; // mantém 1px/2px
  return (n / 16).toFixed(4).replace(/\.?0+$/, "") + "rem";
}

for (const file of files) {
  const input = readFileSync(file, "utf8");
  const lines = input.split(/\r?\n/);
  const out = lines.map(line => {
    const trimmed = line.trim();
    // Media queries: converte px em em
    if (trimmed.startsWith("@media")) {
      return line.replace(/(-?\d*\.?\d+)px/g, (m, n) => {
        const v = parseFloat(n);
        return (v / 16).toFixed(4).replace(/\.?0+$/, "") + "em";
      });
    }
    // Pula conversão em sombras e outlines (mantêm px)
    if (/box-shadow|text-shadow|^\s*outline\b|^\s*outline-|filter\s*:.*drop-shadow/.test(line)) {
      return line;
    }
    // Converte px para rem (1px/2px permanecem)
    return line.replace(/(-?\d*\.?\d+)px/g, pxToRem);
  });
  writeFileSync(file, out.join("\n"), "utf8");
  console.log(`Convertido: ${file}`);
}
console.log("Conversão px -> rem concluída.");
