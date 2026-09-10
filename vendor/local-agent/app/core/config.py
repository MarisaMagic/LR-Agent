"""LR-Agent-local 本地配置。

仅保留 Agent 编排相关字段；账号 / 数据库 / Redis / MinIO / SMTP 等云端配置
仍由 LR-Agent-backend 持有，本地服务不涉及。
"""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "LR-Agent Local"
    app_env: Literal["development", "staging", "production", "testing"] = "development"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    # 本地服务只监听 127.0.0.1，CORS 默认放开 Electron renderer
    cors_origins: list[str] = ["http://localhost:1212"]

    # Assist 工具循环
    agent_max_tool_rounds: int = 20

    # 上下文 / 读取限制
    agent_chat_vision_max_edge: int = 1280
    agent_chat_vision_jpeg_quality: int = 85
    agent_read_file_max_bytes: int = 524_288
    agent_read_file_max_lines: int = 2000
    agent_read_document_max_pages: int = 30
    agent_grep_max_results: int = 50
    agent_grep_max_files_scanned: int = 500
    agent_list_dir_max_entries: int = 80

    # 功能开关
    agent_mutation_enabled: bool = True
    agent_document_write_enabled: bool = True

    # 标注 LLM
    annotation_llm_temperature: float = 0.0
    annotation_prepare_temperature: float = 0.1
    annotation_vision_map_concurrency: int = 3
    annotation_vision_map_validate: bool = True
    annotation_vision_map_max_retries: int = 1
    annotation_label_pool_preflight: Literal["off", "auto", "always"] = "auto"
    annotation_label_pool_preflight_min_extra: int = 2

    # 允许 http 协议的 LLM base_url（本地代理场景）
    llm_base_url_allow_http: bool = False

    @property
    def is_development(self) -> bool:
        return self.app_env == "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
