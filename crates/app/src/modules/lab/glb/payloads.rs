use super::MAX_DECODED_RESOURCE_BYTES;
use awsm_renderer_codec_meshopt::{Filter, Mode, decode_buffer_view};
use gltf::{Document, buffer::Source};
use std::borrow::Cow;

fn range(bytes: &[u8], offset: u64, length: u64) -> Option<&[u8]> {
    let end = offset.checked_add(length)?;
    bytes.get(usize::try_from(offset).ok()?..usize::try_from(end).ok()?)
}

fn data_uri(uri: &str) -> Option<Vec<u8>> {
    data_url::DataUrl::process(uri)
        .ok()?
        .decode_to_vec()
        .ok()
        .map(|(bytes, _)| bytes)
}

fn fallback(buffer: gltf::Buffer<'_>) -> bool {
    buffer
        .extension_value("EXT_meshopt_compression")
        .is_some_and(|value| value["fallback"] == true)
}

fn buffers<'a>(document: &Document, bin: &'a [u8]) -> Option<Vec<Cow<'a, [u8]>>> {
    let mut buffers = Vec::new();
    let mut expanded = 0_usize;
    for buffer in document.buffers() {
        expanded = expanded.checked_add(buffer.length())?;
        if expanded > MAX_DECODED_RESOURCE_BYTES {
            return None;
        }
        let data = match buffer.source() {
            Source::Uri(uri) => Cow::Owned(data_uri(uri)?),
            Source::Bin if fallback(buffer.clone()) => Cow::Owned(vec![0; buffer.length()]),
            Source::Bin if buffer.index() == 0 => Cow::Borrowed(bin),
            _ => return None,
        };
        if data.len() < buffer.length() {
            return None;
        }
        buffers.push(data);
    }
    for view in document.views() {
        let Some(extension) = view.extension_value("EXT_meshopt_compression") else {
            continue;
        };
        let source = usize::try_from(extension["buffer"].as_u64()?).ok()?;
        if fallback(document.buffers().nth(source)?) {
            return None;
        }
        let bytes = range(
            buffers.get(source)?,
            extension["byteOffset"].as_u64().unwrap_or(0),
            extension["byteLength"].as_u64()?,
        )?;
        let count = usize::try_from(extension["count"].as_u64()?).ok()?;
        let stride = usize::try_from(extension["byteStride"].as_u64()?).ok()?;
        if count.checked_mul(stride)? != view.length() {
            return None;
        }
        let mode = Mode::from_gltf(extension["mode"].as_str()?)?;
        let filter = Filter::from_gltf(extension["filter"].as_str().unwrap_or("NONE"))?;
        let decoded = decode_buffer_view(bytes, count, stride, mode, filter).ok()?;
        let target = buffers.get_mut(view.buffer().index())?.to_mut();
        target
            .get_mut(view.offset()..view.offset().checked_add(view.length())?)?
            .copy_from_slice(&decoded);
    }
    Some(buffers)
}

fn view_bytes<'a>(view: gltf::buffer::View<'_>, buffers: &'a [Cow<'_, [u8]>]) -> Option<&'a [u8]> {
    range(
        buffers.get(view.buffer().index())?,
        view.offset() as u64,
        view.length() as u64,
    )
}

fn valid_draco(
    bytes: &[u8],
    primitive: &gltf::Primitive<'_>,
    extension: &serde_json::Value,
) -> bool {
    let limits = draco_core::DecodeLimits::default()
        .with_max_decoded_bytes(MAX_DECODED_RESOURCE_BYTES as u64)
        .with_max_points((MAX_DECODED_RESOURCE_BYTES / 12) as u64)
        .with_max_faces((MAX_DECODED_RESOURCE_BYTES / 12) as u64);
    let mut buffer = draco_core::DecoderBuffer::new(bytes).with_limits(limits);
    if primitive.mode() == gltf::mesh::Mode::Points {
        let mut cloud = draco_core::PointCloud::new();
        if draco_core::PointCloudDecoder::new()
            .decode(&mut buffer, &mut cloud)
            .is_err()
        {
            return false;
        }
        valid_cloud(&cloud, extension)
    } else {
        let mut mesh = draco_core::Mesh::new();
        if draco_core::MeshDecoder::new()
            .decode(&mut buffer, &mut mesh)
            .is_err()
            || mesh.num_faces() == 0
        {
            return false;
        }
        valid_cloud(&mesh, extension)
    }
}

fn valid_cloud(cloud: &draco_core::PointCloud, extension: &serde_json::Value) -> bool {
    for index in 0..cloud.num_attributes() {
        let attribute = cloud.attribute(index);
        if attribute.data_type() == draco_core::DataType::Float32
            && attribute.buffer().data().chunks_exact(4).any(|value| {
                !f32::from_le_bytes(value.try_into().expect("four-byte chunk")).is_finite()
            })
        {
            return false;
        }
    }
    cloud.num_points() > 0
        && extension["attributes"]
            .as_object()
            .is_some_and(|attributes| {
                attributes.values().all(|id| {
                    id.as_u64()
                        .and_then(|id| u32::try_from(id).ok())
                        .is_some_and(|id| cloud.attribute_by_unique_id(id).is_some())
                })
            })
}

fn valid_geometry(document: &Document, buffers: &[Cow<'_, [u8]>]) -> bool {
    for mesh in document.meshes() {
        for primitive in mesh.primitives() {
            if let Some(extension) = primitive.extension_value("KHR_draco_mesh_compression") {
                let Some(view) = extension["bufferView"]
                    .as_u64()
                    .and_then(|index| document.views().nth(index as usize))
                else {
                    return false;
                };
                let Some(bytes) = view_bytes(view, buffers) else {
                    return false;
                };
                if !valid_draco(bytes, &primitive, extension) {
                    return false;
                }
                continue;
            }
            let Some(positions) = primitive.get(&gltf::Semantic::Positions) else {
                return false;
            };
            if positions.dimensions() != gltf::accessor::Dimensions::Vec3 {
                return false;
            }
            if let Some(indices) = primitive.indices()
                && (indices.dimensions() != gltf::accessor::Dimensions::Scalar
                    || indices.normalized()
                    || !matches!(
                        indices.data_type(),
                        gltf::accessor::DataType::U8
                            | gltf::accessor::DataType::U16
                            | gltf::accessor::DataType::U32
                    ))
            {
                return false;
            }
            let reader =
                primitive.reader(|buffer| buffers.get(buffer.index()).map(|data| data.as_ref()));
            if positions.data_type() == gltf::accessor::DataType::F32
                && reader
                    .read_positions()
                    .is_none_or(|positions| positions.flatten().any(|value| !value.is_finite()))
            {
                return false;
            }
            if reader.read_indices().is_some_and(|indices| {
                indices
                    .into_u32()
                    .any(|index| index as usize >= positions.count())
            }) {
                return false;
            }
        }
    }
    true
}

fn valid_image(bytes: &[u8], mime_type: Option<&str>, basis: bool) -> bool {
    if bytes.starts_with(b"\xabKTX 20\xbb\r\n\x1a\n") {
        if !basis || mime_type.is_some_and(|mime| mime != "image/ktx2") {
            return false;
        }
        let Ok(container) = ktx2::Reader::new(bytes) else {
            return false;
        };
        let header = container.header();
        if u64::from(header.pixel_width)
            .checked_mul(u64::from(header.pixel_height))
            .and_then(|pixels| pixels.checked_mul(4))
            .is_none_or(|bytes| bytes > MAX_DECODED_RESOURCE_BYTES as u64)
            || container
                .levels()
                .any(|level| level.uncompressed_byte_length > MAX_DECODED_RESOURCE_BYTES as u64)
        {
            return false;
        }
        let Ok(texture) = basisu::Transcoder::new(bytes) else {
            return false;
        };
        if texture.layer_count() > 1 || texture.face_count() != 1 {
            return false;
        }
        for level in 0..texture.level_count() {
            let target = basisu::TargetFormat::Rgba32;
            let Ok(size) = texture.output_size(level, target) else {
                return false;
            };
            if size > MAX_DECODED_RESOURCE_BYTES
                || texture
                    .transcode(level, target, basisu::DecodeFlags::NONE)
                    .is_err()
            {
                return false;
            }
        }
        return true;
    }
    if basis {
        return false;
    }
    let Ok(mut reader) = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
    else {
        return false;
    };
    if mime_type.is_some_and(|mime| {
        reader
            .format()
            .is_none_or(|format| format.to_mime_type() != mime)
    }) {
        return false;
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_RESOURCE_BYTES as u64);
    reader.limits(limits);
    reader.decode().is_ok()
}

pub(super) fn valid(document: &Document, bin: &[u8]) -> bool {
    let Some(buffers) = buffers(document, bin) else {
        return false;
    };
    if !valid_geometry(document, &buffers) {
        return false;
    }
    let basis_sources: std::collections::HashSet<_> = document
        .textures()
        .filter_map(|texture| {
            texture
                .extension_value("KHR_texture_basisu")
                .and_then(|extension| extension["source"].as_u64())
        })
        .collect();
    let ordinary_sources: std::collections::HashSet<_> = document
        .textures()
        .filter(|texture| texture.extension_value("KHR_texture_basisu").is_none())
        .map(|texture| texture.source().index())
        .collect();
    for image in document.images() {
        if ordinary_sources.contains(&image.index())
            && basis_sources.contains(&(image.index() as u64))
        {
            return false;
        }
        let basis = basis_sources.contains(&(image.index() as u64));
        match image.source() {
            gltf::image::Source::View { view, mime_type } => {
                if view_bytes(view, &buffers)
                    .is_none_or(|bytes| !valid_image(bytes, Some(mime_type), basis))
                {
                    return false;
                }
            }
            gltf::image::Source::Uri { uri, mime_type } => {
                let Ok(url) = data_url::DataUrl::process(uri) else {
                    return false;
                };
                let media = format!("{}/{}", url.mime_type().type_, url.mime_type().subtype);
                if mime_type.is_some_and(|mime| mime != media)
                    || data_uri(uri).is_none_or(|bytes| !valid_image(&bytes, Some(&media), basis))
                {
                    return false;
                }
            }
        }
    }
    true
}
