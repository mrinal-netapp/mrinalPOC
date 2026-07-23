.PHONY: build docker-build test clean fmt fmt-check

# All Go sources in this module (excludes vendor if present).
GO_FILES := $(shell find . -type f -name '*.go' ! -path './vendor/*')

build:
	go build -o bin/workflow-engine ./cmd/server

docker-build:
	docker build -t workflow-engine:latest .

test: fmt-check
	go test ./...

fmt:
	gofmt -w $(GO_FILES)

# Mirrors .github/workflows/main.yml gofmt check for workflow-engine.
fmt-check:
	@unformatted="$$(gofmt -l $(GO_FILES) | grep -v '^$$' || true)"; \
	if [ -n "$$unformatted" ]; then \
		echo "The following files are not gofmt'd:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

clean:
	rm -rf bin/

