"""本地服务依赖注入：仅 Settings，无认证 / 数据库 / Redis。"""

from typing import Annotated

from fastapi import Depends

from app.core.config import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]
