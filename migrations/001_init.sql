CREATE TABLE plans (
  id                SERIAL PRIMARY KEY,
  account_id        INT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('account', 'user')),
  name              TEXT NOT NULL,
  monthly_allowance BIGINT NOT NULL CHECK (monthly_allowance >= 0),
  max_per_request   BIGINT NOT NULL CHECK (max_per_request > 0),
  is_predefined     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  plan_id      INT NOT NULL REFERENCES plans(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE plans
  ADD CONSTRAINT plans_account_fk
  FOREIGN KEY (account_id) REFERENCES accounts(id);

CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  account_id  INT NOT NULL REFERENCES accounts(id),
  external_id TEXT NOT NULL,
  plan_id     INT NOT NULL REFERENCES plans(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

CREATE TABLE account_usage (
  account_id INT NOT NULL REFERENCES accounts(id),
  month      DATE NOT NULL,
  used       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

CREATE TABLE user_usage (
  user_id INT NOT NULL REFERENCES users(id),
  month   DATE NOT NULL,
  used    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE requests (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INT NOT NULL REFERENCES accounts(id),
  user_id       INT NOT NULL REFERENCES users(id),
  request_id    TEXT NOT NULL,
  units         BIGINT NOT NULL CHECK (units > 0),
  accepted      BOOLEAN NOT NULL,
  rejected_by   TEXT CHECK (rejected_by IN ('account', 'user')),
  rejected_rule TEXT CHECK (rejected_rule IN ('monthly_allowance', 'max_per_request')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);

CREATE INDEX idx_requests_account_created ON requests (account_id, created_at DESC);
CREATE INDEX idx_requests_user_created ON requests (user_id, created_at DESC);
