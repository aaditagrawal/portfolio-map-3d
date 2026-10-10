/* A command or file with a copy button. The result is announced to screen readers. */
import { useEffect, useRef, useState } from "react";
import { Check, CopyIcon } from "./Icons.tsx";

function shellTokens(code: string) {
  const tokens = code.match(/\s+|&&|\|\||[|;]|"(?:\\.|[^"\\])*"|'[^']*'|[^\s|;]+/g) ?? [];
  let command = true;
  return tokens.map((text, index) => {
    if (/^\s+$/.test(text)) {
      if (text.includes("\n")) command = true;
      return text;
    }
    let kind: string;
    if (/^(?:&&|\|\||[|;])$/.test(text)) {
      kind = "operator";
      command = true;
    } else {
      kind = command ? "command" : /^['"]/.test(text) ? "string" : /^-/.test(text) ? "flag" : text.includes("/") || text === "my-map" ? "path" : "argument";
      command = false;
    }
    return <span className={`shell-${kind}`} key={index}>{text}</span>;
  });
}

export function CodeBlock({ code, label, lang = "shell" }: { code: string; label: string; lang?: "shell" | "json" }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(code);
      ok = true;
    } catch {
      // No clipboard access (an insecure origin, or permission denied): select the text instead.
      const sel = window.getSelection();
      if (sel && pre.current) {
        const range = document.createRange();
        range.selectNodeContents(pre.current);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    setCopied(ok ? "yes" : "no");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className={`code code-${lang}`}>
      <pre ref={pre} tabIndex={0} aria-label={label}>
        <code>{lang === "shell" ? shellTokens(code) : code}</code>
      </pre>
      <button type="button" className="code-copy" onClick={copy}>
        {copied === "yes" ? <Check size={16} /> : <CopyIcon size={16} />}
        <span>{copied === "yes" ? "Copied" : "Copy"}</span>
        <span className="sr-only">: {label}</span>
      </button>
      <span className="sr-only" role="status">
        {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "Could not copy; the text is selected." : ""}
      </span>
    </div>
  );
}
