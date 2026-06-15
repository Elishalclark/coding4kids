CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL DEFAULT 'kid',
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            parent_email TEXT,
            age_band TEXT,
            plan TEXT NOT NULL DEFAULT 'trial',
            trial_ends TEXT,
            family_id INTEGER,
            tokens INTEGER DEFAULT 0,
            avatar TEXT,
            owned_items TEXT,
            link_token TEXT,
            created_at TEXT NOT NULL
        , age_years INTEGER, consent_status TEXT DEFAULT 'not_required', consent_method TEXT, consent_at TEXT, consent_by TEXT, consent_token TEXT, consent_confirm_token TEXT, school TEXT, suspended INTEGER DEFAULT 0, suspend_reason TEXT, suspend_until TEXT, reset_token TEXT, reset_expires TEXT, brand_name TEXT, brand_logo TEXT, quiz_done INTEGER DEFAULT 0, quiz_level TEXT, quiz_plan TEXT, start_unit INTEGER, class_code TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT);
CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            to_email TEXT, kind TEXT, body TEXT, child_id INTEGER,
            link_token TEXT, created_at TEXT
        );
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE progress (user_id INTEGER NOT NULL, lesson_id TEXT NOT NULL, completed_at TEXT NOT NULL, PRIMARY KEY (user_id, lesson_id));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE chat_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
CREATE TABLE lessons (
            id TEXT PRIMARY KEY, position INTEGER, emoji TEXT, title TEXT, blurb TEXT,
            level TEXT, xp INTEGER, published INTEGER DEFAULT 1, steps TEXT, quiz TEXT,
            unit INTEGER DEFAULT 1
        );
CREATE TABLE unit_tests (
            user_id INTEGER NOT NULL, unit INTEGER NOT NULL,
            passed INTEGER DEFAULT 0, best_score INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0,
            updated_at TEXT, PRIMARY KEY (user_id, unit)
        );
CREATE TABLE consent_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            child_id INTEGER, child_username TEXT, method TEXT, granted_by TEXT, detail TEXT, created_at TEXT
        );
CREATE TABLE notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, kind TEXT, body TEXT, created_at TEXT
        );
CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL, author_name TEXT, title TEXT, code TEXT,
            shared INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
        );
CREATE TABLE project_likes (
            user_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, project_id)
        );
CREATE TABLE comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
            author_name TEXT, body TEXT, reported INTEGER DEFAULT 0, created_at TEXT
        );
CREATE TABLE takedowns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL, requester_id INTEGER, requester_name TEXT,
            reason TEXT, status TEXT DEFAULT 'pending',
            created_at TEXT, resolved_at TEXT, resolved_by TEXT
        );
CREATE TABLE account_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT, name TEXT, username TEXT, password_hash TEXT, salt TEXT,
            email TEXT, plan TEXT, requested_by TEXT, status TEXT DEFAULT 'pending',
            created_at TEXT, resolved_at TEXT, resolved_by TEXT
        );
