import unittest

from sqlalchemy import event

from entropy_app.database import create_database_engine


class DatabaseEngineTests(unittest.TestCase):
    def test_postgresql_connections_use_a_bounded_timeout(self):
        engine = create_database_engine(
            "postgresql+psycopg://entropy_app:placeholder@127.0.0.1:5432/entropy_dev"
        )
        self.addCleanup(engine.dispose)
        connect_args = {}

        def capture_connect_args(_dialect, _connection_record, _args, kwargs):
            connect_args.update(kwargs)
            raise RuntimeError("Stop before connecting to PostgreSQL")

        event.listen(engine, "do_connect", capture_connect_args)
        with self.assertRaisesRegex(RuntimeError, "Stop before connecting"):
            engine.connect()
        self.assertEqual(connect_args["connect_timeout"], 5)


if __name__ == "__main__":
    unittest.main()
