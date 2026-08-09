.PHONY: help install test check pack verify publish clean

VERSION := $(shell node -p "require('./package.json').version")
NAME    := $(shell node -p "require('./package.json').name")

help:
	@echo "$(NAME) $(VERSION)"
	@echo
	@echo "  make test      run the test suite"
	@echo "  make check     validate the example config"
	@echo "  make pack      build the tarball and list what would ship"
	@echo "  make verify    clean install + test + check + pack  (the pre-publish gate)"
	@echo "  make publish OTP=123456   publish to npm (2FA one-time password required)"
	@echo "  make clean     remove node_modules and any tarball"

install:
	@npm install

test:
	@npm test

# The example config is shipped in the package, so a broken one is a broken release.
check:
	@node bin/acp2api.js --config acp2api.example.yaml --check

pack:
	@rm -f $(NAME)-*.tgz
	@npm pack
	@echo
	@echo "contents:"
	@tar -tzf $(NAME)-$(VERSION).tgz | sed 's/^/  /'

# `npm ci` rather than `npm install`: it installs exactly the lockfile, which is what
# a consumer gets. A test suite that passes only against a drifted tree proves nothing.
verify:
	@echo "==> $(NAME) $(VERSION)"
	@npm ci
	@$(MAKE) test
	@$(MAKE) check
	@$(MAKE) pack
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
