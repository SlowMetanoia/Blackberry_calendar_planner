"""Print a VAPID key pair for an untracked environment file."""

from base64 import urlsafe_b64encode

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid02


def main() -> None:
    vapid = Vapid02()
    vapid.generate_keys()
    private = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
    public = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    print("WEB_PUSH_VAPID_PUBLIC_KEY=" + urlsafe_b64encode(public).decode().rstrip("="))
    print("WEB_PUSH_VAPID_PRIVATE_KEY=" + urlsafe_b64encode(private).decode().rstrip("="))


if __name__ == "__main__":
    main()
