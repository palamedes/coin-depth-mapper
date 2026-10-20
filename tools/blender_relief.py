"""Preview a Relief Depth Studio depth map in Blender at real size.

Builds a plane in millimetres, displaces it with the depth PNG (white = highest), gives it a
metal material, a raking sun light and a camera. Blender shows the *shape* the map
describes; it doesn't simulate LightBurn's passes (use the Slices tab for that).

Inside Blender (any 4.x or 5.x):
    blender --python tools/blender_relief.py -- depth.png --depth-mm 0.5

Options (after the "--"):
    --width-mm W     physical width; default comes from the PNG's DPI (pHYs), else 40
    --depth-mm D     relief depth from black to white, default 0.5
    --base-mm B      add a solid base under the deepest point (0 = just the surface)
    --grid N         vertices along the longer side, default 600
    --material M     clay (matte, best for judging shape, default) or steel
    --save out.blend save the scene
    --render out.png render a still (Cycles, CPU) and quit; useful without a display
    --render-size WxH  size of that still, default 960x720
    --tilt DEG       camera angle away from straight down, default 36

Headless without the Blender app: pip install bpy, then
    python tools/blender_relief.py depth.png --render preview.png
"""

from __future__ import annotations

import argparse
import math
import struct
import sys


def png_info(path: str) -> tuple[int, int, float | None]:
    """(width, height, dpi or None) straight from the PNG header and pHYs chunk."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    pos, w, h, dpi = 8, 0, 0, None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif kind == b"pHYs":
            ppx, _ppy, unit = struct.unpack(">IIB", body[:9])
            if unit == 1 and ppx:
                dpi = ppx * 0.0254
        elif kind == b"IDAT":
            break
        pos += 12 + length
    return w, h, dpi


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser(prog="blender_relief.py", description=__doc__.split("\n\n")[0])
    p.add_argument("png")
    p.add_argument("--width-mm", type=float)
    p.add_argument("--depth-mm", type=float, default=0.5)
    p.add_argument("--base-mm", type=float, default=0.0)
    p.add_argument("--grid", type=int, default=600)
    p.add_argument("--material", choices=["clay", "steel"], default="clay")
    p.add_argument("--save")
    p.add_argument("--render")
    p.add_argument("--render-size", default="960x720")
    p.add_argument("--tilt", type=float, default=36.0)
    return p.parse_args(argv)


def build(args: argparse.Namespace) -> None:
    import bpy

    w_px, h_px, dpi = png_info(args.png)
    width = args.width_mm or (w_px / dpi * 25.4 if dpi else 40.0)
    height = width * h_px / w_px
    print(f"{args.png}: {w_px}x{h_px} px, {dpi or 'no'} DPI -> {width:.2f} x {height:.2f} mm, relief {args.depth_mm} mm")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # 1 Blender unit = 1 mm, so the N panel and measurements read in millimetres.
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = "MILLIMETERS"

    longer = max(w_px, h_px)
    n = max(8, min(args.grid, longer))
    xs = max(2, round(n * w_px / longer))
    ys = max(2, round(n * h_px / longer))
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=xs, y_subdivisions=ys, size=1, calc_uvs=True)
    obj = bpy.context.active_object
    obj.name = "Relief"
    obj.scale = (width, height, 1)
    bpy.ops.object.transform_apply(scale=True)

    img = bpy.data.images.load(args.png, check_existing=False)
    img.colorspace_settings.name = "Non-Color"  # heights, not colours: no gamma curve
    tex = bpy.data.textures.new("ReliefMap", type="IMAGE")
    tex.image = img
    tex.extension = "EXTEND"
    mod = obj.modifiers.new("Relief", "DISPLACE")
    mod.texture = tex
    mod.texture_coords = "UV"
    mod.direction = "Z"
    mod.mid_level = 0.0
    mod.strength = args.depth_mm
    if args.base_mm > 0:
        solid = obj.modifiers.new("Base", "SOLIDIFY")
        solid.thickness = args.base_mm
        solid.offset = -1
        solid.use_even_offset = True
    bpy.ops.object.shade_smooth()

    steel = args.material == "steel"
    mat = bpy.data.materials.new("Polished steel" if steel else "Clay")
    if bpy.app.version < (5, 0, 0):  # node trees are always on from Blender 5
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.8, 0.8, 0.82, 1) if steel else (0.62, 0.6, 0.57, 1)
    bsdf.inputs["Metallic"].default_value = 1.0 if steel else 0.0
    bsdf.inputs["Roughness"].default_value = 0.3 if steel else 0.65
    obj.data.materials.append(mat)

    size = max(width, height)
    # A low raking sun shows small bumps and pits the way a loupe under a lamp would.
    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(64), 0, math.radians(-40)))
    bpy.context.active_object.data.energy = 4.0 if steel else 3.0
    world = bpy.data.worlds.new("World")
    scene.world = world
    if bpy.app.version < (5, 0, 0):
        world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.12, 0.12, 0.13, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0 if steel else 0.5

    tilt = math.radians(max(0.0, min(80.0, args.tilt)))
    dist = size * 1.68
    bpy.ops.object.camera_add(location=(0, -dist * math.sin(tilt), dist * math.cos(tilt)), rotation=(tilt, 0, 0))
    cam = bpy.context.active_object
    cam.data.lens = 50
    cam.data.clip_start = 0.1
    cam.data.clip_end = size * 20
    scene.camera = cam

    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=args.save)
        print(f"saved {args.save}")
    if args.render:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 24
        rw, rh = (int(v) for v in args.render_size.lower().split("x"))
        scene.render.resolution_x = rw
        scene.render.resolution_y = rh
        scene.render.filepath = args.render
        bpy.ops.render.render(write_still=True)
        print(f"rendered {args.render}")


if __name__ == "__main__":
    build(parse_args())
