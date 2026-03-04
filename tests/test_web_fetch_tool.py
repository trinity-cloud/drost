from __future__ import annotations

import pytest

from drost.tools.web_fetch import WebFetchTool


def test_html_to_text_prefers_readable_content_and_strips_noise() -> None:
    raw_html = """
    <html>
      <head>
        <title>Sample</title>
        <style>.x{display:none}</style>
        <script>window.tracking = "secret";</script>
      </head>
      <body>
        <header>Site Header</header>
        <nav>Home | World | Sports</nav>
        <main>
          <h1>Eclipse Update</h1>
          <p>Start of totality: 6:04 AM EST</p>
          <p>End of totality: 7:02 AM EST</p>
        </main>
        <aside>Sign up for newsletter</aside>
        <footer>All rights reserved</footer>
      </body>
    </html>
    """
    text = WebFetchTool._html_to_text(raw_html)
    assert "Eclipse Update" in text
    assert "Start of totality: 6:04 AM EST" in text
    assert "End of totality: 7:02 AM EST" in text
    assert "Home | World | Sports" not in text
    assert "window.tracking" not in text
    assert "All rights reserved" not in text


def test_html_to_text_falls_back_to_regex_if_parser_path_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def _fail(_cls: type[WebFetchTool], _raw_html: str) -> str:
        raise RuntimeError("parse error")

    monkeypatch.setattr(WebFetchTool, "_html_to_text_with_soup", classmethod(_fail))
    text = WebFetchTool._html_to_text(
        "<html><body><script>var x = 1;</script><p>Hello world</p></body></html>"
    )
    assert text == "Hello world"
