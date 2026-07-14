#!/usr/bin/env python3
"""
phpinfo() のコピペテキスト（HTMLでもプレーンテキストでも可）から
WPローカル環境構築に必要な情報を抽出してJSONで返す。

入力: ファイルパス または stdin
出力: JSON（標準出力）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


# ---------- ユーティリティ ----------

def _strip_html(text: str) -> str:
    """HTMLタグを取り除いてプレーンテキスト化する（簡易）。"""
    # <td>と<th>の境界をタブに、<tr>を改行に置換してテーブル構造を保つ
    text = re.sub(r"</(td|th)>\s*<(td|th)[^>]*>", "\t", text, flags=re.IGNORECASE)
    text = re.sub(r"</tr>\s*", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<h\d[^>]*>", "\n## ", text, flags=re.IGNORECASE)
    text = re.sub(r"</h\d>", "\n", text, flags=re.IGNORECASE)
    # その他のタグを除去
    text = re.sub(r"<[^>]+>", "", text)
    # HTMLエンティティの素朴な復元
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    return text


def _normalize(text: str) -> str:
    """HTMLっぽければHTMLとして処理し、最終的に行ベースのテキストにする。"""
    if "<html" in text.lower() or "<table" in text.lower() or "<td" in text.lower():
        text = _strip_html(text)
    # 連続する空白を整理
    # 連続するタブのみ1つに整理（値の中の半角スペースは温存する）
    text = re.sub(r"\t+", "\t", text)
    return text


# ---------- 抽出ロジック ----------

VERSION_RE = re.compile(r"\b(\d+)\.(\d+)\.(\d+)\b")


def _extract_php_version(text: str) -> str | None:
    """
    phpinfo() の冒頭に出る "PHP Version => x.y.z" or "PHP Version x.y.z" を拾う。
    """
    # "PHP Version" + 任意の区切り + バージョン
    m = re.search(r"PHP\s*Version\s*(?:=>|:)?\s*(\d+\.\d+\.\d+)", text, re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def _extract_system(text: str) -> str | None:
    """System => Linux ... 行を返す。"""
    m = re.search(r"System\s*(?:=>|:)?\s*(.+)", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return None


def _extract_server_software(text: str) -> str | None:
    """SERVER_SOFTWARE → Apache/2.4.x or nginx/1.x を抽出。"""
    m = re.search(
        r"SERVER_SOFTWARE\s*(?:=>|:)?\s*(\S[^\n]*)",
        text,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()
    return None


def _extract_document_root(text: str) -> str | None:
    m = re.search(
        r"DOCUMENT_ROOT\s*(?:=>|:)?\s*(\S[^\n]*)",
        text,
        re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()
    return None


def _extract_mysql(text: str) -> dict[str, str | None]:
    """
    mysqli / mysqlnd / pdo_mysql のセクションから
    クライアントバージョン・サーバーバージョン情報を拾う。
    """
    result: dict[str, str | None] = {
        "client_version": None,
        "server_version": None,
        "extension": None,
    }

    # mysqli の Client API library version （行末・タブ・改行まで拾う）
    m = re.search(
        r"Client\s*API\s*(?:library\s*)?version\s*(?:=>|:)?\s*([^\t\n\r]+)",
        text,
        re.IGNORECASE,
    )
    if m:
        result["client_version"] = m.group(1).strip()

    # フォールバック: mysqlnd セクション内のバージョン値
    if not result["client_version"]:
        m = re.search(
            r"mysqlnd\s+([\d][\d.]*(?:[\-+][\w.]+)?)",
            text,
            re.IGNORECASE,
        )
        if m:
            result["client_version"] = m.group(1).strip()

    # mysqli / pdo_mysql どちらが有効か
    if re.search(r"\bmysqli\b", text, re.IGNORECASE):
        result["extension"] = "mysqli"
    if re.search(r"\bpdo_mysql\b", text, re.IGNORECASE):
        result["extension"] = (
            "mysqli+pdo_mysql" if result["extension"] == "mysqli" else "pdo_mysql"
        )

    return result


# php拡張モジュールのセクションヘッダ列挙（phpinfo()は ## extension名 で章立てされる）
EXTENSION_HEADER_RE = re.compile(r"^##\s+([a-zA-Z0-9_]+)\s*$", re.MULTILINE)


def _extract_extensions(text: str) -> list[str]:
    """章見出しからモジュール名を集める。重複排除して返す。"""
    names = EXTENSION_HEADER_RE.findall(text)
    seen: set[str] = set()
    result: list[str] = []
    for n in names:
        # phpinfo冒頭のメタ章（"PHP Credits" 等）は除外
        lower = n.lower()
        if lower in {
            "phpcredits",
            "phplicense",
            "configuration",
            "environment",
            "phpvariables",
            "additionalmodules",
            "core",
        }:
            continue
        if n not in seen:
            seen.add(n)
            result.append(n)
    return result


def _looks_sensitive(text: str) -> list[str]:
    """phpinfo の中によく混入する秘匿情報の警告対象を列挙。"""
    warnings: list[str] = []
    for pattern, label in [
        (r"AWS_SECRET", "AWS_SECRET 環境変数"),
        (r"DB_PASSWORD", "DB_PASSWORD 環境変数"),
        (r"GITHUB_TOKEN", "GITHUB_TOKEN 環境変数"),
        (r"BEARER\s+[A-Za-z0-9_\-]{20,}", "Bearer トークン疑い"),
        (r"-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----", "秘密鍵ブロック"),
    ]:
        if re.search(pattern, text):
            warnings.append(label)
    return warnings


# ---------- メイン ----------

def parse(text: str) -> dict[str, Any]:
    norm = _normalize(text)
    php_version = _extract_php_version(norm)
    php_major_minor = ".".join(php_version.split(".")[:2]) if php_version else None
    return {
        "php_version": php_version,
        "php_major_minor": php_major_minor,
        "system": _extract_system(norm),
        "server_software": _extract_server_software(norm),
        "document_root": _extract_document_root(norm),
        "mysql": _extract_mysql(norm),
        "extensions": _extract_extensions(norm),
        "sensitive_warnings": _looks_sensitive(norm),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse phpinfo() output to JSON")
    parser.add_argument(
        "input",
        nargs="?",
        help="phpinfo出力テキストのファイルパス。省略時はstdin。",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="JSONをインデント付きで整形",
    )
    args = parser.parse_args()

    if args.input:
        text = Path(args.input).read_text(encoding="utf-8", errors="replace")
    else:
        text = sys.stdin.read()

    result = parse(text)
    indent = 2 if args.pretty else None
    print(json.dumps(result, ensure_ascii=False, indent=indent))
    return 0


if __name__ == "__main__":
    sys.exit(main())
