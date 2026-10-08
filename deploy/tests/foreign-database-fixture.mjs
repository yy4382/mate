import Database from "better-sqlite3";

const db = new Database("/fixture/control-plane.sqlite");
db.exec("CREATE TABLE synthetic_sentinel(value TEXT)");
db.prepare("INSERT INTO synthetic_sentinel VALUES(?)").run("preserve");
db.pragma("application_id = 1296257100");
db.pragma("user_version = 999");
db.close();
