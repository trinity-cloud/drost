from drost.storage import parse_session_key, session_key_for_telegram_chat


def test_parse_session_key() -> None:
    key = session_key_for_telegram_chat(42, "s1")
    parsed = parse_session_key(key)
    assert parsed.agent == "main"
    assert parsed.channel == "telegram"
    assert parsed.identifier == "42__s1"
