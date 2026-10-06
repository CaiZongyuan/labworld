//! Validation-only binding. No WASI, filesystem, network, database or geometry export.
use draco_core::{
    DataType, DecodeLimits, DecoderBuffer, Mesh, MeshDecoder, PointCloud, PointCloudDecoder,
};
mod glb;

const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;

#[no_mangle]
pub unsafe extern "C" fn validate_glb_structure(pointer: *const u8, length: usize) -> u32 {
    u32::from(glb::valid(std::slice::from_raw_parts(pointer, length)))
}

#[no_mangle]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn deallocate(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
        pointer, length,
    )));
}

fn valid_cloud(cloud: &PointCloud, required_ids: &[u8]) -> bool {
    if cloud.num_points() == 0 || !required_ids.len().is_multiple_of(4) {
        return false;
    }
    for index in 0..cloud.num_attributes() {
        let attribute = cloud.attribute(index);
        if attribute.data_type() == DataType::Float32
            && attribute.buffer().data().chunks_exact(4).any(|part| {
                !f32::from_le_bytes(part.try_into().expect("four-byte scalar")).is_finite()
            })
        {
            return false;
        }
    }
    required_ids.chunks_exact(4).all(|part| {
        cloud
            .attribute_by_unique_id(u32::from_le_bytes(part.try_into().expect("four-byte ID")))
            .is_some()
    })
}

#[no_mangle]
pub unsafe extern "C" fn validate_draco(
    pointer: *const u8,
    length: usize,
    points: u32,
    ids: *const u8,
    ids_length: usize,
    decoded_bytes_limit: u32,
    point_limit: u32,
    face_limit: u32,
) -> u32 {
    let bytes = std::slice::from_raw_parts(pointer, length);
    let required_ids = std::slice::from_raw_parts(ids, ids_length);
    let limits = DecodeLimits::default()
        .with_max_decoded_bytes(u64::from(decoded_bytes_limit))
        .with_max_points(u64::from(point_limit))
        .with_max_faces(u64::from(face_limit));
    let mut buffer = DecoderBuffer::new(bytes).with_limits(limits);
    let valid = if points == 1 {
        let mut cloud = PointCloud::new();
        PointCloudDecoder::new()
            .decode(&mut buffer, &mut cloud)
            .is_ok()
            && valid_cloud(&cloud, required_ids)
    } else {
        let mut mesh = Mesh::new();
        MeshDecoder::new().decode(&mut buffer, &mut mesh).is_ok()
            && mesh.num_faces() > 0
            && valid_cloud(&mesh, required_ids)
    };
    u32::from(valid)
}

#[no_mangle]
pub unsafe extern "C" fn validate_image(pointer: *const u8, length: usize, mime: u32) -> u32 {
    let bytes = std::slice::from_raw_parts(pointer, length);
    let Ok(mut reader) = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format()
    else {
        return 0;
    };
    let expected = match mime {
        1 => image::ImageFormat::Png,
        2 => image::ImageFormat::Jpeg,
        3 => image::ImageFormat::Gif,
        4 => image::ImageFormat::WebP,
        _ => return 0,
    };
    if reader.format() != Some(expected) {
        return 0;
    }
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits);
    u32::from(reader.decode().is_ok())
}
