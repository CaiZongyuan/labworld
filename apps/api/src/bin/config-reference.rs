fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fields = labos_threejs_platform::config::FIELDS
        .iter()
        .chain(labos_threejs_platform::telemetry::FIELDS)
        .chain(labos_threejs_app::modules::jobs::FIELDS)
        .chain(labos_threejs_platform::cache::FIELDS)
        .chain(labos_threejs_app::modules::rate_limit::FIELDS)
        .chain(labos_threejs_platform::mail::FIELDS)
        .chain(labos_threejs_app::modules::mail::FIELDS)
        .chain(labos_threejs_app::modules::identity::PASSWORD_RESET_FIELDS)
        .chain(labos_threejs_app::modules::lab::RETENTION_FIELDS)
        .collect::<Vec<_>>();
    // example:knowledge:config-reference:start
    let fields = fields
        .into_iter()
        .chain(labos_threejs_app::modules::knowledge::CONFIG_FIELDS)
        .collect::<Vec<_>>();
    // example:knowledge:config-reference:end
    println!("{}", serde_json::to_string_pretty(&fields)?);
    Ok(())
}
