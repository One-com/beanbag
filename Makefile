.PHONY: lint
lint:
	@./node_modules/.bin/one-lint-js --backend lib test

.PHONY: test
test:
	@./node_modules/.bin/mocha $(MOCHA_ARGS)