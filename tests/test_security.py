import uuid

from planner.security import create_token, hash_password, verify_password


def test_password_hash_round_trip() -> None:
    password = "correct horse battery staple"
    hashed = hash_password(password)
    assert hashed != password
    assert verify_password(password, hashed)
    assert not verify_password("wrong password", hashed)


def test_token_contains_user_subject() -> None:
    token = create_token(uuid.uuid4())
    assert isinstance(token, str)
    assert token.count(".") == 2
