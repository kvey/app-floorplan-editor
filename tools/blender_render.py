# Headless Blender render of a client-exported .glb from the WEB CLIENT'S camera.
# Invoked by server.py:
#   blender -b --factory-startup --python tools/blender_render.py -- <glb> <out.png> <cam.json>
# cam.json = { "camera": {pos:[x,y,z], target:[x,y,z], up:[x,y,z], fov:deg}, "width":W, "height":H }
#
# The viewer's three.js camera has up = +Z and a VERTICAL fov, looking from `pos`
# at `target`. We rebuild that exact view in Blender so the render matches what
# the user sees on screen. The .glb already carries the model's PBR materials and
# the sun (directional light, direction = the editor's sun angle).
#
# Rendered with EEVEE NEXT. To get the sun to actually FILTER IN through the
# windows/skylights and BOUNCE to fill the rooms (not just a flat ambient wash),
# we: (1) make the sun strong, (2) enable raytracing for correctly-occluded
# indirect light + glass refraction, and (3) bake an IRRADIANCE VOLUME over the
# building so the sun landing on the floor bounces up onto the walls/ceiling. The
# roof's shadow is baked into that volume, so the rooms are lit by light that came
# through the openings, not by uniform world ambient.
import json
import math
import sys

import bpy
import mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
glb_path, out_path, cam_path = argv[0], argv[1], argv[2]
cfg = json.load(open(cam_path))
cam = cfg.get("camera", {})
W = int(cfg.get("width", 960))
H = int(cfg.get("height", 640))


# Progress markers for the server to relay to the client. `a`/`b` are the percent
# range this phase spans and `secs` its rough duration, so the server can smoothly
# interpolate the bar across the long blocking steps (bake, render).
def prog(a, b, secs, label):
    print("@P %d %d %.1f %s" % (a, b, secs, label), flush=True)


# clean scene + import the model
prog(6, 20, 2.0, "Importing model")
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path)

# Shadow-only objects (e.g. a HIDDEN roof): invisible to the camera but still
# casting shadows, so the floor below stays lit through the skylights/patio —
# the floor/roof filtering matches the client while LIGHTING is preserved.
shadow_only = set(cfg.get("shadowOnly", []))
if shadow_only:
    for o in bpy.data.objects:
        base = o.name.split(".")[0]                # imported dupes get .001 suffixes
        if o.name in shadow_only or base in shadow_only:
            try:                                   # Eevee Next / Cycles ray visibility
                o.visible_camera = False
                o.visible_shadow = True
                o.visible_diffuse = False
                o.visible_glossy = False
            except AttributeError:
                o.hide_render = True               # legacy fallback (loses shadow)

# Glass (windows + skylights) must NOT cast shadows, otherwise the panes block the
# sun and no daylight reaches the floor. With shadow casting off, the wall/roof
# opening lets sunlight stream through onto the floor below — light comes in
# through the windows/skylights. The panes still render to camera (you see them).
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    if "Glass" in o.name or "Glass" in (o.active_material.name if o.active_material else ""):
        try:
            o.visible_shadow = False
        except AttributeError:
            pass

prog(20, 30, 1.5, "Placing camera & lights")
# --- camera: reproduce the three.js view (eye/target/up, vertical fov) ---
# The client sends coordinates in the viewer's Z-up world. The .glb is Y-up
# (glTF), so Blender's importer rotates all geometry by +90° about X on import:
#   (x, y, z)  ->  (x, -z, y)
# Apply that SAME transform to the camera vectors so the camera lines up with the
# imported geometry — otherwise the view is rotated/offset (Y and Z swapped).
def to_blender(v):
    return mathutils.Vector((v[0], -v[2], v[1]))

eye = to_blender(cam.get("pos", [40, -60, 60]))
tgt = to_blender(cam.get("target", [0, 0, 0]))
up = to_blender(cam.get("up", [0, 0, 1]))
fov_deg = float(cam.get("fov", 45.0))

fwd = (tgt - eye).normalized()                 # direction the camera looks
right = fwd.cross(up).normalized()             # camera local +X
true_up = right.cross(fwd).normalized()        # camera local +Y
# Blender camera looks down its local -Z, so local +Z = -forward.
rot = mathutils.Matrix((
    (right.x, true_up.x, -fwd.x, 0.0),
    (right.y, true_up.y, -fwd.y, 0.0),
    (right.z, true_up.z, -fwd.z, 0.0),
    (0.0, 0.0, 0.0, 1.0),
))
cam_data = bpy.data.cameras.new("ClientCam")
cam_data.sensor_fit = "VERTICAL"               # match three's vertical fov
cam_data.lens_unit = "FOV"
cam_data.angle_y = math.radians(fov_deg)
cam_obj = bpy.data.objects.new("ClientCam", cam_data)
bpy.context.scene.collection.objects.link(cam_obj)
cam_obj.matrix_world = mathutils.Matrix.Translation(eye) @ rot
bpy.context.scene.camera = cam_obj

scene = bpy.context.scene

# Engine: EEVEE NEXT (real-time). Its raytracing gives correctly-OCCLUDED indirect
# light + glass refraction, so the sun/sky reach the rooms only THROUGH the
# windows/skylights and BOUNCE off the floor — light filtering in, not flat
# ambient. (Fall back to legacy Eevee name if Next is unavailable.)
scene.render.engine = "BLENDER_EEVEE_NEXT"
if scene.render.engine != "BLENDER_EEVEE_NEXT":
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng
            break
        except Exception:
            continue

# --- daylight sky. The (shadow-casting) roof occludes it from above, so with
#     Eevee's raytraced occlusion the sky only reaches the rooms through the
#     openings. Kept moderate so the SUN is the dominant source (not flat fill). ---
world = bpy.data.worlds.new("Sky")
world.use_nodes = True
nt = world.node_tree
nodes, links = nt.nodes, nt.links
out_node = nodes["World Output"]
# The moderate ambient used for LIGHTING (unchanged) — keeps the sun the dominant
# source and the interior lit by sun-bounce through the openings, not flat fill.
bg = nodes["Background"]
bg.inputs[0].default_value = (0.32, 0.44, 0.60, 1.0)   # daylight sky blue
bg.inputs[1].default_value = 0.8
# A realistic clear-blue gradient sky (horizon haze → zenith deep blue, NO clouds)
# shown ONLY to the camera, so the render's backdrop matches the viewer's sky
# without changing how the rooms are lit (lighting rays still see `bg`).
geo = nodes.new("ShaderNodeNewGeometry")
sep = nodes.new("ShaderNodeSeparateXYZ")
links.new(geo.outputs["Incoming"], sep.inputs[0])
mapr = nodes.new("ShaderNodeMapRange")
mapr.inputs["From Min"].default_value = -0.15
mapr.inputs["From Max"].default_value = 0.65
links.new(sep.outputs["Z"], mapr.inputs["Value"])
ramp = nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = (0.58, 0.74, 0.92, 1.0)   # horizon haze-blue
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = (0.13, 0.34, 0.72, 1.0)   # zenith deep blue
links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
sky_bg = nodes.new("ShaderNodeBackground")
links.new(ramp.outputs["Color"], sky_bg.inputs[0])
sky_bg.inputs[1].default_value = 1.0
lp = nodes.new("ShaderNodeLightPath")
mix = nodes.new("ShaderNodeMixShader")
links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
links.new(bg.outputs[0], mix.inputs[1])        # non-camera rays → moderate ambient (lighting)
links.new(sky_bg.outputs[0], mix.inputs[2])    # camera rays → blue gradient sky
links.new(mix.outputs[0], out_node.inputs["Surface"])
scene.world = world

# --- strong, soft sun: the key light that streams through the windows and then
#     bounces. The .glb sun carries the editor's DIRECTION; we make it BRIGHT. ---
SUN_W = 12.0
for o in bpy.data.objects:
    if o.type == "LIGHT" and o.data.type == "SUN":
        o.data.energy = max(o.data.energy, SUN_W)
        o.data.angle = math.radians(1.0)
        o.data.use_shadow = True

# Eevee Next: raytracing (indirect bounce + occlusion + glass), soft jittered sun
# shadows, plenty of viewport/render TAA samples to resolve the GI cleanly.
ee = scene.eevee
for attr, val in (("use_raytracing", True), ("use_shadows", True),
                  ("use_shadow_jitter_viewport", True)):
    try:
        setattr(ee, attr, val)
    except Exception:
        pass
try:
    ee.ray_tracing_options.resolution_scale = "1"      # full-res rays = cleaner GI
except Exception:
    pass
try:
    ee.shadow_ray_count = 2
    ee.shadow_step_count = 6
except Exception:
    pass
try:                                                   # Fast GI diffuse bounce (4.3+)
    ee.use_fast_gi = True
    ee.fast_gi_method = "GLOBAL_ILLUMINATION"
    ee.fast_gi_bounces = 4
except Exception:
    pass
try:
    ee.taa_render_samples = 128
except Exception:
    pass

# --- irradiance volume + bake: this is what makes the sun BOUNCE. An irradiance
#     grid covering the building captures the indirect diffuse light (the sun patch
#     on the floor bouncing up to the walls/ceiling), WITH occlusion baked in (the
#     roof blocks the sky from above) — so the rooms are lit by light that filtered
#     through the openings and bounced, not by flat world ambient. Baking works in
#     Blender's background mode for Eevee Next. ---
prog(30, 58, 12.0, "Baking light bounce (GI)")
try:
    gmin = mathutils.Vector((1e18, 1e18, 1e18))
    gmax = -gmin
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            gmin = mathutils.Vector((min(gmin[i], w[i]) for i in range(3)))
            gmax = mathutils.Vector((max(gmax[i], w[i]) for i in range(3)))
    gctr = (gmin + gmax) / 2
    gext = gmax - gmin
    bpy.ops.object.lightprobe_add(type="VOLUME", location=(gctr.x, gctr.y, gctr.z))
    pv = bpy.context.object
    pv.scale = (max(0.5, gext.x / 2 * 1.05), max(0.5, gext.y / 2 * 1.05), max(0.5, gext.z / 2 * 1.05))
    pd = pv.data
    pd.resolution_x = max(4, min(28, round(gext.x / 2.5)))   # ~2.5 ft cells
    pd.resolution_y = max(4, min(28, round(gext.y / 2.5)))
    pd.resolution_z = max(4, min(28, round(gext.z / 2.5)))
    pd.capture_world = True
    pd.capture_indirect = True
    bpy.ops.object.lightprobe_cache_bake(subset="ALL")
    print("PROBE_BAKED", pd.resolution_x, pd.resolution_y, pd.resolution_z)
except Exception as e:
    print("PROBE_FAILED", repr(e))

# tonemap: AgX with a touch of exposure so interiors read without blowing the sun.
try:
    scene.view_settings.view_transform = "AgX"
except Exception:
    pass
scene.view_settings.exposure = 0.5

scene.render.resolution_x = W
scene.render.resolution_y = H
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = out_path
prog(58, 97, 14.0, "Rendering")
bpy.ops.render.render(write_still=True)
print("RENDER_OK", out_path)
