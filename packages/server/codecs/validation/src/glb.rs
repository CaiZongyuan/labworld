// Compatibility binding of the retained gltf 1.4.1 structural/range validation.
// Payloads are independently decoded by the Node codec adapter before publication.
use gltf::json::validation::{Error, Validate};

pub(super) const MAX_DECODED_RESOURCE_BYTES: usize = 256 * 1024 * 1024;

pub(super) fn valid(bytes: &[u8]) -> bool {
    let Ok(glb) = gltf::binary::Glb::from_slice(bytes) else {
        return false;
    };
    if glb.header.length as usize != bytes.len()
        || !bytes.len().is_multiple_of(4)
        || !glb.json.len().is_multiple_of(4)
        || glb
            .bin
            .as_ref()
            .is_some_and(|bin| !bin.len().is_multiple_of(4))
    {
        return false;
    }
    let Ok(mut root) = gltf::json::deserialize::from_slice::<gltf::json::Root>(&glb.json) else {
        return false;
    };
    if root.asset.version != "2.0"
        || root
            .asset
            .min_version
            .as_deref()
            .is_some_and(|version| version != "2.0")
    {
        return false;
    }
    // These extensions are implemented by the production Three.js loader, not gltf-rs.
    let supported = [
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
        "KHR_mesh_quantization",
        "KHR_materials_unlit",
        "KHR_texture_transform",
        "KHR_lights_punctual",
        "KHR_materials_clearcoat",
        "KHR_materials_transmission",
        "KHR_materials_volume",
        "KHR_materials_ior",
        "KHR_materials_specular",
        "KHR_materials_sheen",
        "KHR_materials_iridescence",
        "KHR_materials_emissive_strength",
        "KHR_materials_anisotropy",
        "EXT_mesh_gpu_instancing",
    ];
    if root
        .extensions_required
        .iter()
        .any(|extension| !supported.contains(&extension.as_str()))
    {
        return false;
    }
    // gltf-json's primitive hook indexes POSITION before reporting invalid references.
    if root
        .meshes
        .iter()
        .flat_map(|mesh| &mesh.primitives)
        .any(|primitive| {
            primitive
                .attributes
                .values()
                .any(|index| index.value() >= root.accessors.len())
        })
    {
        return false;
    }
    let mut draco_views = std::collections::HashSet::new();
    for primitive in root.meshes.iter().flat_map(|mesh| &mesh.primitives) {
        if let Some(draco) = primitive
            .extensions
            .as_ref()
            .and_then(|extensions| extensions.others.get("KHR_draco_mesh_compression"))
        {
            if draco["bufferView"]
                .as_u64()
                .is_none_or(|index| index >= root.buffer_views.len() as u64)
                || !draco["attributes"].is_object()
            {
                return false;
            }
            for (semantic, index) in &primitive.attributes {
                let Ok(serde_json::Value::String(semantic)) = serde_json::to_value(semantic) else {
                    return false;
                };
                if draco["attributes"][semantic].as_u64().is_some() {
                    draco_views.insert(format!("accessors[{}].bufferView", index.value()));
                }
            }
            if let Some(index) = primitive.indices {
                draco_views.insert(format!("accessors[{}].bufferView", index.value()));
            }
        }
    }
    // Project Basis image references into the validator's core texture source field.
    for texture in &mut root.textures {
        let basis = texture
            .extensions
            .as_ref()
            .and_then(|extensions| extensions.others.get("KHR_texture_basisu"));
        if let Some(basis) = basis {
            let source = basis["source"].as_u64();
            let Some(source) = source.filter(|source| *source < root.images.len() as u64) else {
                return false;
            };
            if texture.source.value() == u32::MAX as usize {
                texture.source = gltf::json::Index::new(source as u32);
            }
        }
    }
    if root.images.iter().any(|image| {
        image.buffer_view.is_some() == image.uri.is_some()
            || (image.buffer_view.is_some() && image.mime_type.is_none())
    }) {
        return false;
    }
    let mut valid = true;
    root.validate(&root, gltf::json::Path::new, &mut |path, error| {
        if error != Error::Unsupported
            && !(error == Error::Missing && draco_views.contains(&path().to_string()))
        {
            valid = false;
        }
    });
    if !valid {
        return false;
    }
    for buffer in &root.buffers {
        if let Some(uri) = &buffer.uri {
            if !uri.starts_with("data:") {
                return false;
            }
        } else if buffer.byte_length.0 > glb.bin.as_ref().map_or(0, |bin| bin.len() as u64)
            && !buffer
                .extensions
                .as_ref()
                .and_then(|extensions| extensions.others.get("EXT_meshopt_compression"))
                .is_some_and(|extension| extension["fallback"] == true)
        {
            return false;
        }
    }
    if root.images.iter().any(|image| {
        image
            .uri
            .as_ref()
            .is_some_and(|uri| !uri.starts_with("data:"))
    }) {
        return false;
    }
    for view in &root.buffer_views {
        let buffer = &root.buffers[view.buffer.value()];
        if view
            .byte_offset
            .unwrap_or_default()
            .0
            .checked_add(view.byte_length.0)
            .is_none_or(|end| end > buffer.byte_length.0)
        {
            return false;
        }
    }
    if !valid_graph(&root) {
        return false;
    }
    let document = gltf::Document::from_json_without_validation(root);
    let mut expanded_accessors = 0_usize;
    for accessor in document.accessors() {
        if accessor.count() == 0 {
            return false;
        }
        let Some(expanded) = accessor
            .count()
            .checked_mul(accessor.size())
            .and_then(|size| size.checked_add(expanded_accessors))
        else {
            return false;
        };
        if expanded > MAX_DECODED_RESOURCE_BYTES {
            return false;
        }
        expanded_accessors = expanded;
        if let Some(sparse) = accessor.sparse() {
            let count = sparse.count();
            let indices = sparse.indices();
            let values = sparse.values();
            if count == 0
                || count > accessor.count()
                || count
                    .checked_mul(indices.index_type().size())
                    .and_then(|size| size.checked_add(indices.offset()))
                    .is_none_or(|end| end > indices.view().length())
                || count
                    .checked_mul(accessor.size())
                    .and_then(|size| size.checked_add(values.offset()))
                    .is_none_or(|end| end > values.view().length())
            {
                return false;
            }
        }
        if let Some(view) = accessor.view() {
            let stride = view.stride().unwrap_or(accessor.size());
            let end = (accessor.count() - 1)
                .checked_mul(stride)
                .and_then(|length| length.checked_add(accessor.offset()))
                .and_then(|length| length.checked_add(accessor.size()));
            if stride < accessor.size() || end.is_none_or(|end| end > view.length()) {
                return false;
            }
        }
    }
    true
}

fn valid_graph(root: &gltf::json::Root) -> bool {
    let Some(scene) = root.scenes.get(root.scene.map_or(0, |scene| scene.value())) else {
        return false;
    };
    // Bound traversal and reject cyclic or multiply parented node graphs before the client loader.
    let mut parents = vec![0_usize; root.nodes.len()];
    for children in root.nodes.iter().filter_map(|node| node.children.as_ref()) {
        for child in children {
            parents[child.value()] += 1;
            if parents[child.value()] > 1 {
                return false;
            }
        }
    }
    let mut queue: std::collections::VecDeque<_> = parents
        .iter()
        .enumerate()
        .filter_map(|(index, count)| (*count == 0).then_some(index))
        .collect();
    let mut visited = 0;
    while let Some(index) = queue.pop_front() {
        visited += 1;
        for child in root.nodes[index].children.iter().flatten() {
            parents[child.value()] -= 1;
            if parents[child.value()] == 0 {
                queue.push_back(child.value());
            }
        }
    }
    if visited != root.nodes.len() {
        return false;
    }
    let mut queue: Vec<_> = scene.nodes.iter().map(|node| node.value()).collect();
    while let Some(index) = queue.pop() {
        let node = &root.nodes[index];
        if node
            .mesh
            .is_some_and(|index| !root.meshes[index.value()].primitives.is_empty())
        {
            return true;
        }
        queue.extend(node.children.iter().flatten().map(|child| child.value()));
    }
    false
}
