# Vendored model code

Only the network definitions needed for inference are copied here, so the app does not
pull in the training/export dependencies of the upstream projects (open3d, pycolmap,
gsplat, moviepy, tensorflow...). Both upstream projects are Apache-2.0; their LICENSE
files are kept next to the code. Model *weights* are downloaded separately and carry
their own licenses (shown in the app).

| Folder | Upstream | Commit |
|---|---|---|
| `depth_anything_3/` | https://github.com/ByteDance-Seed/Depth-Anything-3 (`src/depth_anything_3`, network code + 4 configs) | 3d835ec1a5802d64a8b8b15f817a1ab54809bfe4 |
| `depth_anything_v2/` | https://github.com/glp1001/MonoreliefV2 (`depth_anything_v2`, used by MonoRelief V2) | 51476795225f8a4c706b244b9e2357c3eba4785c |

Local changes: none. The app puts this folder on `sys.path` when a model is loaded.
