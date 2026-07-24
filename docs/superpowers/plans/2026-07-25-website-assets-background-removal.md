# 官网图片素材透明背景处理实施计划

> **供智能体执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。所有步骤使用复选框跟踪。

**目标：** 将 `D:\Python\resource` 中的 8 张 PNG 处理为保留主体及阴影、移除外围背景和水印的透明图片，并迁移到 `apps/website/public`。

**架构：** 每张图片独立执行“背景替换候选生成、透明化、视觉验证、像素属性验证”，中间产物保留在工作区临时目录。全部成品通过验证后统一写入官网静态资源目录，再移除源目录中的对应原图，避免失败时丢失素材。

**技术栈：** 内置 `image_gen` 图片编辑、图片透明化辅助脚本、PowerShell、System.Drawing、Next.js `public` 静态资源目录。

## 全局约束

- 保留图标形状、文字、内部材质、颜色、边缘细节和主体阴影。
- 图片本体以外的外围区域必须透明。
- 移除右下角生成水印。
- 不重绘、不改色、不改变构图，不主动裁剪主体。
- 保持原始画布尺寸、原始文件名和 PNG 格式。
- 不覆盖目标目录中已有的同名文件。
- 对应成品验证失败时，不移除源文件。

---

### 任务 1：建立批处理工作区并锁定输入

**文件：**
- 创建：`tmp/imagegen/website-assets/`
- 读取：`D:\Python\resource\AP.png`
- 读取：`D:\Python\resource\empty.png`
- 读取：`D:\Python\resource\IMGIcon.png`
- 读取：`D:\Python\resource\Noempty.png`
- 读取：`D:\Python\resource\PDFIcon.png`
- 读取：`D:\Python\resource\PPTIcon.png`
- 读取：`D:\Python\resource\TxtIcon.png`
- 读取：`D:\Python\resource\XLSIcon.png`

**接口：**
- 输入：8 张源 PNG。
- 输出：源文件名、尺寸、哈希和像素格式清单，供后续验证使用。

- [ ] **步骤 1：确认目标目录不存在同名文件**

运行：

```powershell
$names = 'AP.png','empty.png','IMGIcon.png','Noempty.png','PDFIcon.png','PPTIcon.png','TxtIcon.png','XLSIcon.png'
$names | ForEach-Object {
  [PSCustomObject]@{
    Name = $_
    Exists = Test-Path -LiteralPath (Join-Path 'apps\website\public' $_)
  }
}
```

预期：8 个 `Exists` 值均为 `False`。

- [ ] **步骤 2：建立临时工作目录**

运行：

```powershell
New-Item -ItemType Directory -Path 'tmp\imagegen\website-assets' -Force
```

预期：目录位于工作区内，源图片保持不变。

- [ ] **步骤 3：记录源图片属性**

运行：

```powershell
Get-ChildItem -LiteralPath 'D:\Python\resource' -File -Filter '*.png' |
  Get-FileHash -Algorithm SHA256
```

预期：返回且仅返回 8 条 SHA-256 记录。

### 任务 2：逐张生成透明背景成品

**文件：**
- 创建：`tmp/imagegen/website-assets/AP.png`
- 创建：`tmp/imagegen/website-assets/empty.png`
- 创建：`tmp/imagegen/website-assets/IMGIcon.png`
- 创建：`tmp/imagegen/website-assets/Noempty.png`
- 创建：`tmp/imagegen/website-assets/PDFIcon.png`
- 创建：`tmp/imagegen/website-assets/PPTIcon.png`
- 创建：`tmp/imagegen/website-assets/TxtIcon.png`
- 创建：`tmp/imagegen/website-assets/XLSIcon.png`

**接口：**
- 输入：任务 1 锁定的 8 张源 PNG。
- 输出：8 张同名、同尺寸、带 Alpha 通道的候选成品。

- [ ] **步骤 1：对每张源图执行背景提取编辑**

对每张图片分别调用内置 `image_gen`，使用以下固定编辑要求：

```text
用途：background-extraction
素材类型：官网透明 PNG 图标
主要要求：只移除图标本体以外的外围背景，并移除右下角生成水印。
必须保留：图标形状、文字、内部白色或浅灰区域、颜色、材质、高光、边缘细节和主体投影。
构图约束：保持主体的位置、比例、朝向和原始画布比例；不得裁剪、重绘、补字或改色。
中间背景：使用完全均匀的纯绿色 #00ff00，不得包含纹理、渐变、反射或新增阴影。
禁止：水印、新文字、新物体、主体变形。
```

预期：每次调用只处理一张源图，并产生一张纯绿色外围背景的候选图。

- [ ] **步骤 2：将纯绿色外围背景转换为 Alpha 通道**

对每张候选图运行已安装的透明化辅助脚本：

```powershell
$names = 'AP.png','empty.png','IMGIcon.png','Noempty.png','PDFIcon.png','PPTIcon.png','TxtIcon.png','XLSIcon.png'
foreach ($name in $names) {
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($name)
  python 'C:\Users\Administrator\.codex\skills\.system\imagegen\scripts\remove_chroma_key.py' `
    --input (Join-Path 'tmp\imagegen\website-assets' "$stem-chroma.png") `
    --out (Join-Path 'tmp\imagegen\website-assets' $name) `
    --auto-key border `
    --soft-matte `
    --transparent-threshold 12 `
    --opaque-threshold 220 `
    --despill
}
```

预期：生成 8 张带 Alpha 通道的同名 PNG。

- [ ] **步骤 3：恢复原始画布尺寸**

逐张读取源图尺寸；若图片编辑结果尺寸不同，按源图画布比例缩放候选图，使成品尺寸分别为：

```text
AP.png：1536 × 960
其余 7 张：2048 × 2048
```

预期：8 张成品尺寸与对应源图完全一致，主体比例不变。

### 任务 3：验证透明度和视觉完整性

**文件：**
- 检查：`tmp/imagegen/website-assets/*.png`

**接口：**
- 输入：任务 2 的 8 张候选成品。
- 输出：通过验证的 8 张最终成品；任意一张失败则停止迁移。

- [ ] **步骤 1：验证文件集合和尺寸**

运行：

```powershell
Get-ChildItem -LiteralPath 'tmp\imagegen\website-assets' -File -Filter '*.png'
```

预期：最终成品文件名与源文件名一一对应，不包含中间文件。

- [ ] **步骤 2：验证 Alpha 通道和透明四角**

使用 `System.Drawing.Bitmap` 读取每张成品，验证：

```text
PixelFormat 包含 Alpha；
四个角像素的 Alpha 值均为 0；
图片中至少存在一个 Alpha 值为 255 的主体像素；
图片中至少存在一个 0 到 255 之间的半透明边缘或阴影像素。
```

预期：8 张成品全部满足四项条件。

- [ ] **步骤 3：逐张执行视觉检查**

使用图片查看工具逐张检查以下内容：

```text
图标轮廓完整；
AP、IMG、PDF、PPT、TXT、XLS 文字准确；
内部白色和浅灰材质未被误删；
主体阴影保留；
外围背景不可见；
右下角水印不可见；
没有绿色边缘、重绘痕迹或主体位移。
```

预期：8 张图片全部通过。任意一张失败时，仅重新处理该图片，不进入任务 4。

### 任务 4：写入官网素材目录并完成迁移

**文件：**
- 创建：`apps/website/public/`
- 创建：`apps/website/public/AP.png`
- 创建：`apps/website/public/empty.png`
- 创建：`apps/website/public/IMGIcon.png`
- 创建：`apps/website/public/Noempty.png`
- 创建：`apps/website/public/PDFIcon.png`
- 创建：`apps/website/public/PPTIcon.png`
- 创建：`apps/website/public/TxtIcon.png`
- 创建：`apps/website/public/XLSIcon.png`
- 移除：`D:\Python\resource` 中上述 8 张源 PNG

**接口：**
- 输入：任务 3 验证通过的 8 张最终成品。
- 输出：Next.js 可直接引用的 8 张官网静态图片。

- [ ] **步骤 1：创建 Next.js 标准静态资源目录**

运行：

```powershell
New-Item -ItemType Directory -Path 'apps\website\public'
```

预期：只创建 `public`，不创建额外素材子目录。

- [ ] **步骤 2：复制验证通过的成品**

运行：

```powershell
$names = 'AP.png','empty.png','IMGIcon.png','Noempty.png','PDFIcon.png','PPTIcon.png','TxtIcon.png','XLSIcon.png'
foreach ($name in $names) {
  Copy-Item `
    -LiteralPath (Join-Path 'tmp\imagegen\website-assets' $name) `
    -Destination (Join-Path 'apps\website\public' $name)
}
```

预期：目标目录包含 8 张同名 PNG。

- [ ] **步骤 3：验证目标文件可读**

运行：

```powershell
Get-ChildItem -LiteralPath 'apps\website\public' -File -Filter '*.png'
```

预期：返回 8 张图片，且图片尺寸和透明属性与任务 3 的结果一致。

- [ ] **步骤 4：移除对应源文件**

仅在步骤 3 完全通过后，使用 8 个明确的源路径执行：

```powershell
$names = 'AP.png','empty.png','IMGIcon.png','Noempty.png','PDFIcon.png','PPTIcon.png','TxtIcon.png','XLSIcon.png'
New-Item -ItemType Directory -Path 'tmp\imagegen\website-assets\source-backup' -Force
foreach ($name in $names) {
  Move-Item `
    -LiteralPath (Join-Path 'D:\Python\resource' $name) `
    -Destination (Join-Path 'tmp\imagegen\website-assets\source-backup' $name)
}
```

预期：`D:\Python\resource` 不再包含这 8 张图片；临时备份可用于恢复。

- [ ] **步骤 5：运行最终状态检查**

运行：

```powershell
git status --short
```

预期：只显示新增实施计划和 `apps/website/public` 中的 8 张成品；不包含构建产物。
