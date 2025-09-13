// scrape_ngx.js
// Scrapes: https://african-markets.com/en/stock-markets/ngse/listed-companies
// Filters to 12 tickers: MTNN, UBA, GTCO, ZENITH, ARADEL, TOTAL, AIICO, CORNERST, OKOMUOIL, PRESCO, NESTLE, DANGSUGAR
// Outputs: ngx_listed.json and ngx_listed.csv

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// Map your shorthand to the site’s ?code= param
const TARGETS = {
  MTNN: "MTNN",
  UBA: "UBA",
  GTCO: "GTCO",
  ZENITH: "ZENITHBANK", // site uses ZENITHBANK
  ARADEL: "ARADEL",
  TOTAL: "TOTALNG", // site uses TOTALNG
  AIICO: "AIICO",
  CORNERST: "CORNERST",
  OKOMUOIL: "OKOMUOIL",
  PRESCO: "PRESCO",
  NESTLE: "NESTLE",
  DANGSUGAR: "DANGSUGAR",
};

const TARGET_SET = new Set(Object.values(TARGETS));
const URL =
  "https://african-markets.com/en/stock-markets/ngse/listed-companies";

// Helpers
const toNumber = (txt) => {
  if (!txt) return null;
  const clean = txt.replace(/[, ]+/g, "").trim();
  if (clean === "-" || clean === "") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
};

const parsePercent = (txt) => {
  if (!txt) return null;
  const t = txt.replace(/[\s,%+]/g, "").trim(); // remove space, %, +
  if (t === "-" || t === "") return null;
  // Handle possible negative with leading '-' in the original text
  const neg = /^-/.test(txt.trim());
  const num = Number(t.replace(/^-/, ""));
  if (!Number.isFinite(num)) return null;
  const val = (num / 100) * (neg ? -1 : 1);
  return val;
};

// Extract ?code=XYZ from href like 'listed-companies/company?code=MTNN'
const extractCode = (href) => {
  try {
    const qs = href.split("?")[1] || "";
    const params = new URLSearchParams(qs);
    return (params.get("code") || "").toUpperCase();
  } catch {
    return "";
  }
};

(async () => {
  try {
    const res = await axios.get(URL, {
      headers: {
        // a simple UA helps avoid basic anti-bot filters
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 30000,
    });

    const $ = cheerio.load(res.data);

    // Find the first table that looks like the listings table
    // (has columns: Company, Sector, Price, 1D, YTD, M.Cap, Date)
    const tables = $("table");
    if (tables.length === 0) throw new Error("No tables found on the page.");

    // Pick the table with 7 headers and includes "Company" / "Price" columns
    let $table = null;
    tables.each((_, tbl) => {
      const headers = $(tbl).find(
        "thead tr:first-child td, thead tr:first-child th"
      );
      const headerTexts = headers
        .map((__, h) => $(h).text().trim().toLowerCase())
        .get();
      if (
        headers.length >= 5 &&
        headerTexts.some((t) => t.includes("company")) &&
        headerTexts.some((t) => t.includes("price"))
      ) {
        $table = $(tbl);
        return false; // break
      }
    });

    if (!$table) throw new Error("Could not locate the listings table.");

    const out = [];
    const seen = new Set();

    $table.find("tbody tr").each((_, tr) => {
      const $td = $(tr).find("td");

      // Company + href (to extract code)
      const $a = $td.eq(0).find("a");
      const href = $a.attr("href") || "";
      const code = extractCode(href);

      if (!code || !TARGET_SET.has(code)) return;

      const priceTxt = $td.eq(2).text().trim();
      const dayTxt = $td.eq(3).text().trim();
      const ytdTxt = $td.eq(4).text().trim();
      const dateTxt = $td.eq(6).text().trim();

      const row = {
        ticker: Object.keys(TARGETS).find((k) => TARGETS[k] === code) || code, // your label
        code, // site code
        price: toNumber(priceTxt), // NGN price as number
        day_change_pct: parsePercent(dayTxt), // 1D change as decimal (e.g. 0.015 for +1.5%)
        ytd_pct: parsePercent(ytdTxt), // YTD change as decimal
        date: dateTxt || null, // date field from table (dd/mm)
      };

      out.push(row);
      seen.add(code);
    });

    // Report missing tickers for visibility
    const missing = [...TARGET_SET].filter((c) => !seen.has(c));
    if (missing.length) {
      console.warn(
        "Not found on page (check codes or page structure):",
        missing.join(", ")
      );
    }

    // Write JSON
    fs.writeFileSync("ngx_listed.json", JSON.stringify(out, null, 2));
    console.log("Saved ngx_listed.json");

    // Write CSV
    const toCSV = (rows) => {
      const header = [
        "ticker",
        "code",
        "price",
        "day_change_pct",
        "ytd_pct",
        "date",
      ];
      const esc = (v) =>
        v === null || v === undefined
          ? ""
          : String(v).includes(",") || String(v).includes('"')
          ? `"${String(v).replace(/"/g, '""')}"`
          : String(v);
      const lines = [header.join(",")].concat(
        rows.map((r) =>
          [
            esc(r.ticker),
            esc(r.code),
            esc(r.price),
            esc(r.day_change_pct),
            esc(r.ytd_pct),
            esc(r.date),
          ].join(",")
        )
      );
      return lines.join("\n");
    };

    fs.writeFileSync("ngx_listed.csv", toCSV(out));
    console.log("Saved ngx_listed.csv");

    // Also print to console for quick view
    console.table(
      out.map((r) => ({
        ticker: r.ticker,
        code: r.code,
        price: r.price,
        "1D %":
          typeof r.day_change_pct == null
            ? 0
            : Number(Number(r.day_change_pct).toFixed(5)),
        "YTD %":
          typeof r.ytd_pct == null ? 0 : Number(Number(r.ytd_pct).toFixed(5)),
        date: r.date,
      }))
    );

    exit();
  } catch (err) {
    console.error("Scrape failed:", err.message);
  }
})();
