"""Extract user context from gateway-injected headers and validate project access."""

from fastapi import HTTPException, Request


def get_user_context(request: Request) -> dict:
    user_id = request.headers.get("X-User-ID")
    if not user_id:
        raise HTTPException(status_code=401, detail="Missing auth headers")

    # X-Project-ID may not be in the JWT; fall back to the URL path parameter.
    project_id = (
        request.headers.get("X-Project-ID")
        or request.path_params.get("project_id")
    )
    if not project_id:
        raise HTTPException(status_code=401, detail="Missing project context")

    return {
        "user_id": user_id,
        "user_email": request.headers.get("X-User-Email"),
        "user_name": request.headers.get("X-User-Name"),
        "project_id": project_id,
    }


def validate_project_access(
    url_project_id: str, user_ctx: dict, agent_config: dict
) -> None:
    """Check that URL projectId matches the user context and agent config."""
    ctx_project_id = user_ctx["project_id"]
    config_project_id = agent_config.get("projectId")
    if url_project_id != ctx_project_id:
        raise HTTPException(status_code=403, detail="Project access denied")
    if config_project_id and url_project_id != config_project_id:
        raise HTTPException(status_code=403, detail="Agent does not belong to this project")
