import json
import os
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

import app


class ResolverBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_token = os.environ.get("RESOLVER_API_TOKEN")
        cls.old_allowlist = os.environ.get("RESOLVER_ALLOWED_TRAINER_CODES")
        os.environ["RESOLVER_API_TOKEN"] = "test-only-token"
        os.environ["RESOLVER_ALLOWED_TRAINER_CODES"] = "1111 2222 3333"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.ResolverHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:" + str(cls.server.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        if cls.old_token is None:
            os.environ.pop("RESOLVER_API_TOKEN", None)
        else:
            os.environ["RESOLVER_API_TOKEN"] = cls.old_token
        if cls.old_allowlist is None:
            os.environ.pop("RESOLVER_ALLOWED_TRAINER_CODES", None)
        else:
            os.environ["RESOLVER_ALLOWED_TRAINER_CODES"] = cls.old_allowlist

    def call(self, method, path, body=None, token=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method
        )
        try:
            response = urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_unauthenticated_request_is_rejected_before_database_access(self):
        status, body = self.call(
            "POST", "/api/resolve-trainer", {"trainerCode": "111122223333"}
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "Unauthorized.")

    def test_bad_trainer_code_is_rejected(self):
        status, body = self.call(
            "POST",
            "/api/resolve-trainer",
            {"trainerCode": "1234"},
            "test-only-token",
        )
        self.assertEqual(status, 400)
        self.assertIn("12 digits", body["error"])

    def test_non_allowlisted_code_is_rejected_before_database_access(self):
        status, body = self.call(
            "POST",
            "/api/resolve-trainer",
            {"trainerCode": "999900001111"},
            "test-only-token",
        )
        self.assertEqual(status, 403)
        self.assertIn("allowlist", body["error"])

    def test_wrong_route_does_not_queue_anything(self):
        status, body = self.call(
            "POST", "/api/not-a-resolver", {"trainerCode": "111122223333"},
            "test-only-token",
        )
        self.assertEqual(status, 404)

    def test_allowlist_normalizes_spaces(self):
        self.assertIn("111122223333", app.allowed_codes())

    def test_normal_poll_cadence_is_not_rate_limited(self):
        client = "poll-test-" + str(uuid.uuid4())
        for _ in range(25):
            self.assertTrue(app.rate_allowed(client))

    def test_job_ids_are_uuids(self):
        valid = str(uuid.uuid4())
        self.assertTrue(app.JOB_PATH_RE.fullmatch("/api/resolve-trainer/" + valid))
        self.assertIsNone(app.JOB_PATH_RE.fullmatch(
            "/api/resolve-trainer/not-a-real-job-id"
        ))


if __name__ == "__main__":
    unittest.main()
