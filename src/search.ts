// Search behind a provider interface. Brave if BRAVE_API_KEY is set (best quality,
// structured JSON, no scraping), else keyless DuckDuckGo HTML (works with zero setup).

import { JSDOM } from "jsdom";
import type { SearchResult } from "./types.js";

// Brave gets the honest bot UA. DuckDuckGo's keyless HTML endpoint filters
// non-browser UAs down to an empty page, so its scraper needs a browser UA.
// (Stage 1 reality of keyless search; the Brave path is the real one.)
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface SearchProvider {
  name: string;
  search(query: string, n: number): Promise<SearchResult[]>;
}

export class BraveProvider implements SearchProvider {
  name = "brave";
  constructor(private apiKey: string) {}

  async search(query: string, n: number): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(n, 20)));

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as any;
    const items: any[] = data?.web?.results ?? [];
    return items.slice(0, n).map((r, i) => ({
      title: r.title ?? "",
      url: r.url,
      snippet: stripTags(r.description ?? ""),
      rank: i + 1,
    }));
  }
}

export class DuckDuckGoProvider implements SearchProvider {
  name = "duckduckgo";

  async search(query: string, n: number): Promise<SearchResult[]> {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);

    const html = await res.text();
    const doc = new JSDOM(html).window.document;
    const anchors = [...doc.querySelectorAll("a.result__a")];
    const snippets = [...doc.querySelectorAll(".result__snippet")];

    const out: SearchResult[] = [];
    for (let i = 0; i < anchors.length && out.length < n; i++) {
      const href = decodeDdgUrl((anchors[i] as HTMLAnchorElement).href);
      if (!href) continue;
      out.push({
        title: anchors[i].textContent?.trim() ?? "",
        url: href,
        snippet: snippets[i]?.textContent?.trim() ?? "",
        rank: out.length + 1,
      });
    }
    return out;
  }
}

// DuckDuckGo wraps result links: //duckduckgo.com/l/?uddg=<encoded-target>
function decodeDdgUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return null;
  } catch {
    return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

export function getSearchProvider(): SearchProvider {
  const key = process.env.BRAVE_API_KEY;
  return key ? new BraveProvider(key) : new DuckDuckGoProvider();
}
