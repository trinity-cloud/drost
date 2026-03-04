from __future__ import annotations

from drost.channels.telegram_renderer import markdown_to_telegram_html, split_for_telegram


def test_markdown_to_telegram_html_basic_features() -> None:
    md = """### Header

Hello **bold** and *italic* and ~~strike~~.

- item 1
* item 2

Link: [OpenAI](https://example.com?a=1&b=2)

Inline: `code *not italic*`

---

```python
def hi():
    return "<tag>"
```
"""

    html = markdown_to_telegram_html(md)

    assert "<b>Header</b>" in html
    assert "###" not in html
    assert "<b>bold</b>" in html
    assert "<i>italic</i>" in html
    assert "<s>strike</s>" in html
    assert "• item 1" in html
    assert "• item 2" in html
    assert '<a href="https://example.com?a=1&amp;b=2">OpenAI</a>' in html
    assert "<code>code *not italic*</code>" in html
    assert "\n---\n" not in html
    assert "<pre><code>" in html
    assert "&lt;tag&gt;" in html


def test_split_for_telegram_prefers_newline_boundaries() -> None:
    text = "\n".join(f"line {idx}" for idx in range(400))
    chunks = split_for_telegram(text, max_chars=120)
    assert len(chunks) > 1
    assert all(len(chunk) <= 120 for chunk in chunks)
    assert "".join(chunks).replace("\n", "") in text.replace("\n", "")
