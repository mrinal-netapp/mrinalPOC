# Integration test convenience targets.
# Thin wrappers over the same pytest commands documented in README.md.
# Raw `pytest` invocations continue to work without make; these change no
# flags, env loading, or report output.

SHELL := bash
.DEFAULT_GOAL := help

VENV := .venv
# Prefer the venv's pytest when present, else fall back to whatever is on PATH.
PYTEST := $(if $(wildcard $(VENV)/bin/pytest),$(VENV)/bin/pytest,pytest)

# Local *.local hosts need proxy bypass (see README).
export NO_PROXY := *
export no_proxy := *

# Extra args appended to every run; override e.g. `make kb PYTEST_ARGS="-x"`.
PYTEST_ARGS ?= -v -s

REPORTS := reports
# Per-run work dir + log file, derived from the make-target name ($@).
# $$(date ...) defers to the recipe shell so each run gets a unique dir.
# Set only for the agent-service targets (prefix their recipe with $(RUN_ENV)).
RUN_ENV = WORK_DIR=$(REPORTS)/logs/$@-$$(date +%Y%m%d-%H%M%S) LOG_FILE=$@.log

.PHONY: help setup clean-reports test all smoke projects members models kb postgres mysql s3compatible knowledge-base data-pipeline data-management credentials datasources datasets manual-upload test_agent_service_instantiation test_agent_service_memory test_agent_service_session test_agent_service_orchestration_policy test_agent_service_kb test_agent_service_all test_agent_service_guardrails test_agent_service_overrides test_agent_service_interface test_agent_service_mcp test_agent_service_output test_tools_all tools test_tools_platform test_tools_catalog test_tools_remote test_evals test_evals_templates test_evals_workflow evals evals_templates evals_workflow

help: ## Show available integration-test targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  %-38s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Create .venv and install requirements
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r requirements.txt

clean-reports: ## Remove report output and pytest caches
	rm -rf reports/* .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +

test: ## Run the full suite (pytest -v -s)
	$(PYTEST) $(PYTEST_ARGS)

all: test ## Alias for `test`

smoke: ## Run smoke tests (project lifecycle happy path)
	$(PYTEST) -m smoke $(PYTEST_ARGS)

projects: ## Run the project lifecycle happy path
	$(PYTEST) -m projects $(PYTEST_ARGS)

members: ## Run the user-management (members) happy path (needs MEMBER_TEST_EMAIL)
	$(PYTEST) -m members $(PYTEST_ARGS)

models: ## Run the model happy paths (platform-hosted built-ins; gated provider registration)
	$(PYTEST) -m models $(PYTEST_ARGS)

kb: ## Run all KB pipeline tests
	$(PYTEST) -m kb $(PYTEST_ARGS)

postgres: ## Run the PostgreSQL KB pipeline
	$(PYTEST) -m postgres $(PYTEST_ARGS)

mysql: ## Run the MySQL KB pipeline
	$(PYTEST) -m mysql $(PYTEST_ARGS)

s3compatible: ## Run the S3-compatible KB pipeline
	$(PYTEST) -m s3compatible $(PYTEST_ARGS)

knowledge-base: ## Run all tests under suites/knowledge_base
	$(PYTEST) suites/knowledge_base $(PYTEST_ARGS)

data-pipeline: knowledge-base ## Deprecated alias for knowledge-base

data-management: ## Run all data-management suites (credential, datasource, dataset)
	$(PYTEST) suites/data_management $(PYTEST_ARGS)

credentials: ## Run credential lifecycle tests
	$(PYTEST) suites/data_management -m credential $(PYTEST_ARGS)

datasources: ## Run datasource lifecycle tests
	$(PYTEST) suites/data_management -m datasource $(PYTEST_ARGS)

datasets: ## Run dataset lifecycle tests
	$(PYTEST) suites/data_management -m dataset $(PYTEST_ARGS)

manual-upload: ## Run manual unstructured upload tests
	$(PYTEST) suites/data_management -m manual_upload $(PYTEST_ARGS)

test_agent_service_all: ## Run every suite under suites/agent_service
	$(RUN_ENV) $(PYTEST) suites/agent_service $(PYTEST_ARGS)

test_agent_service_instantiation: ## Run the agent-service instantiation suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/instantiation $(PYTEST_ARGS)

test_agent_service_memory: ## Run the agent-service memory suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/memory $(PYTEST_ARGS)

test_agent_service_session: ## Run the agent-service session suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/session $(PYTEST_ARGS)

test_agent_service_orchestration_policy: ## Run the agent-service orchestration policy suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/orchestration_policy $(PYTEST_ARGS)

test_agent_service_kb: ## Run the agent-service KB retrieval (RAG) suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/kb_retrieval $(PYTEST_ARGS)

test_agent_service_guardrails: ## Run the agent-service guardrails suites
	$(RUN_ENV) $(PYTEST) suites/agent_service/guardrails $(PYTEST_ARGS)

test_agent_service_overrides: ## Run the agent-service config-overrides suites
	$(RUN_ENV) $(PYTEST) suites/agent_service/overrides $(PYTEST_ARGS)

test_agent_service_interface: ## Run the agent-service interface suite (REST, SSE streaming, WebSocket, async invoke/tasks)
	$(RUN_ENV) $(PYTEST) suites/agent_service/interface $(PYTEST_ARGS)

test_agent_service_mcp: ## Run the agent-service MCP tool-call suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/mcp $(PYTEST_ARGS)

test_agent_service_output: ## Run the agent-service structured-output suite
	$(RUN_ENV) $(PYTEST) suites/agent_service/output $(PYTEST_ARGS)

test_tools_all: ## Run every suite under suites/tools (platform + catalog)
	$(RUN_ENV) $(PYTEST) suites/tools $(PYTEST_ARGS)

tools: test_tools_all ## Alias for `test_tools_all`

test_tools_platform: ## Run the platform MCP tools suite
	$(RUN_ENV) $(PYTEST) suites/tools/platform $(PYTEST_ARGS)

test_tools_catalog: ## Run the catalog (managed) MCP tools suite
	$(RUN_ENV) $(PYTEST) suites/tools/catalog $(PYTEST_ARGS)

test_tools_remote: ## Run the remote MCP tools suite
	$(RUN_ENV) $(PYTEST) suites/tools/remote $(PYTEST_ARGS)

test_evals: ## Run the evals suite (templates + workflow)
	$(RUN_ENV) $(PYTEST) suites/evals $(PYTEST_ARGS)

test_evals_templates: ## Run the evals template lifecycle suites
	$(RUN_ENV) $(PYTEST) suites/evals/templates $(PYTEST_ARGS)

test_evals_workflow: ## Run the evals workflow run suites
	$(RUN_ENV) $(PYTEST) suites/evals/workflow $(PYTEST_ARGS)

evals: test_evals ## Alias for `test_evals`
