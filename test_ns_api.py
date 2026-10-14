import unittest

from ns_client import NSClient


class NSClientTests(unittest.TestCase):
    def test_ns_client_defaults(self):
        client = NSClient()
        self.assertIsNone(client.api_key)
        self.assertEqual(client.get_stations(), [])


if __name__ == "__main__":
    unittest.main()
