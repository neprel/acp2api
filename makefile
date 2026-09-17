.PHONY: help install test sdk-test python-sdk-test check spec pack pack-install-smoke verify publish clean

PYTHON ?= python3

VERSION := $(shell node -p "require('./package.json').version")
NAME    := $(shell node -p "require('./package.json').name")

help:
	@echo "$(NAME) $(VERSION)"
	@echo
	@echo "  make test      run the test suite"
	@echo "  make sdk-test  test the HTTP contract through the official OpenAI JS SDK"
	@echo "  make python-sdk-test  test through the pinned Python SDK in a temporary venv"
	@echo "  make check     validate the example config"
	@echo "  make spec      check .hint surfaces against code (requires Node 24+)"
	@echo "  make pack      build the tarball and list what would ship"
	@echo "  make verify    clean install + all offline, spec and packaged-install gates"
	@echo "  make publish OTP=123456   publish to npm (2FA one-time password required)"
	@echo "  make clean     remove node_modules and any tarball"

install:
	@npm install

test:
	@node --test --test-concurrency=4 "test/*.test.js"

sdk-test:
	@node --test test/sdk/sdk.test.js

# Keep Python tooling out of both the npm dependency graph and the user's Python
# environment. CI and local verification use the same pinned SDK in a disposable venv.
python-sdk-test:
	@set -eu; \
	venv=$$(mktemp -d "$${TMPDIR:-/tmp}/acp2api-python-sdk.XXXXXX"); \
	trap 'rm -rf "$$venv"' EXIT HUP INT TERM; \
	$(PYTHON) -m venv "$$venv"; \
	"$$venv/bin/python" -m pip --quiet install --disable-pip-version-check -r test/sdk/python-requirements.txt; \
	node test/sdk/python-sdk-test.mjs "$$venv/bin/python"

# The example config is shipped in the package, so a broken one is a broken release.
check:
	@node bin/acp2api.js --config acp2api.example.yaml --check

# Each source file has a companion .hint declaring the functions, invariants and test
# scenarios it must carry. This asserts the code still matches; when a spec changes on
# purpose, re-run `hint lock` to record the new snapshot. The verifier is a pinned
# dev dependency: absence and verification failure are both hard errors here.
spec:
	@node -e 'if (+process.versions.node.split(".")[0] < 24) { console.error("error: the pinned HINT verifier requires Node 24+"); process.exit(1) }'
	@if [ ! -x node_modules/.bin/hint ]; then \
		echo "error: HINT verifier is missing; run npm ci" >&2; \
		exit 127; \
	fi
	@node_modules/.bin/hint verify 'src/**' 'bin/**' 'test/fixtures/**'

pack:
	@rm -f $(NAME)-*.tgz
	@npm pack
	@echo
	@echo "contents:"
	@tar -tzf $(NAME)-$(VERSION).tgz | sed 's/^/  /'

pack-install-smoke: pack
	@set -eu; \
	tarball=$(NAME)-$(VERSION).tgz; \
	trap 'rm -f "$$tarball"' EXIT HUP INT TERM; \
	node test/pack-install-smoke.mjs "$$tarball"

# `npm ci` rather than `npm install`: it installs exactly the lockfile, which is what
# a consumer gets. A test suite that passes only against a drifted tree proves nothing.
verify:
	@echo "==> $(NAME) $(VERSION)"
	@npm ci
	@$(MAKE) test
	@$(MAKE) sdk-test
	@$(MAKE) check
	@$(MAKE) spec
	@$(MAKE) pack-install-smoke
	@echo
	@echo "ok -- ready to publish $(NAME)@$(VERSION)"

# The account has 2FA. It is the WEB flow: npm prints an authorization URL, opens a
# browser, and waits for approval -- so publishing is interactive and cannot be run
# unattended. Do not "fix" that by adding --auth-type=legacy.
#
# OTP is optional, for an account on TOTP instead:  make publish OTP=123456
publish:
	@if [ ! -f .npmrc ]; then \
		echo "error: .npmrc with the publish token is missing"; exit 1; \
	fi
	@$(MAKE) verify
	@echo
	@echo "==> publishing $(NAME)@$(VERSION) -- approve in the browser when prompted"
	@npm publish $(if $(OTP),--otp=$(OTP))

clean:
	@rm -rf node_modules $(NAME)-*.tgz
