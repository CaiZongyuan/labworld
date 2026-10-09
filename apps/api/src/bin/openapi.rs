fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", labos_threejs_api::openapi().to_pretty_json()?);
    Ok(())
}
