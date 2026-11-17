//! Private production-compiled submission engine. No runtime approval is currently constructible.
use crate::launch_spec::LaunchSpec;
use futures_util::{FutureExt, StreamExt};
use std::{future::Future, time::Duration};
use zbus::{
    connection::Builder,
    zvariant::{OwnedObjectPath, OwnedValue},
};
#[cfg(test)]
const UNIT: &str = "dyoffice-fixture-readonly.service";
#[cfg(test)]
const JOB: &str = "/org/freedesktop/systemd1/job/7";
type Properties = Vec<(String, OwnedValue)>;
type Auxiliary = Vec<(String, Properties)>;
#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1"
)]
trait Manager {
    fn subscribe(&self) -> zbus::Result<()>;
    fn start_transient_unit(
        &self,
        name: &str,
        mode: &str,
        properties: Properties,
        aux: Auxiliary,
    ) -> zbus::Result<OwnedObjectPath>;
    #[zbus(signal)]
    fn job_removed(
        &self,
        id: u32,
        job: OwnedObjectPath,
        unit: String,
        result: String,
    ) -> zbus::Result<()>;
}
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    NotSubmitted,
    JobObserved { job_id: u32, result: String },
    Quarantined,
}
struct Attempt {
    generation: u64,
    attempted: bool,
    used: bool,
    phase: Phase,
    unit_binding: Option<crate::unit_binding::UnitBinding>,
}
impl Attempt {
    fn new(generation: u64) -> Self {
        Self {
            generation,
            attempted: false,
            used: false,
            phase: Phase::NotSubmitted,
            unit_binding: None,
        }
    }
    #[allow(clippy::too_many_arguments)] // private pinned transport and attempt context
    async fn submit_on<F: Future<Output = ()>>(
        &mut self,
        connection: &zbus::Connection,
        destination: &str,
        spec: &LaunchSpec,
        budget: Duration,
        mut cancel: tokio::sync::watch::Receiver<bool>,
        owner_lost: F,
        check_sender: bool,
    ) -> Phase {
        if self.used || budget.is_zero() || budget > Duration::from_secs(2) {
            self.unit_binding = None;
            return if self.attempted {
                Phase::Quarantined
            } else {
                Phase::NotSubmitted
            };
        }
        self.used = true;
        if *cancel.borrow() {
            return Phase::NotSubmitted;
        }
        let owner_lost = owner_lost.fuse();
        tokio::pin!(owner_lost);
        let deadline = tokio::time::Instant::now() + budget;
        let observe_cancel = cancel.clone();
        let result = tokio::select! { biased;
            _=cancel.changed()=>None,
            result=tokio::time::timeout_at(deadline,self.observe(connection,destination,spec,check_sender,owner_lost.as_mut(),observe_cancel,deadline))=>result.ok().and_then(Result::ok),
        };
        let valid = !*cancel.borrow()
            && tokio::time::Instant::now() < deadline
            && owner_lost.as_mut().now_or_never().is_none();
        self.phase = if valid { result } else { None }.unwrap_or(if self.attempted {
            Phase::Quarantined
        } else {
            Phase::NotSubmitted
        });
        if matches!(self.phase, Phase::Quarantined | Phase::NotSubmitted) {
            self.unit_binding = None;
        }
        self.phase.clone()
    }
    #[allow(clippy::too_many_arguments)] // shared production/test control flow; no external API
    async fn submit_and_finalize<F, Q>(
        &mut self,
        connection: &zbus::Connection,
        destination: &str,
        spec: &LaunchSpec,
        deadline: tokio::time::Instant,
        cancel: tokio::sync::watch::Receiver<bool>,
        owner_lost: F,
        check_sender: bool,
        query: Q,
    ) -> Phase
    where
        F: Future<Output = ()>,
        Q: Future<Output = Result<String, ()>>,
    {
        let owner_lost = owner_lost.fuse();
        tokio::pin!(owner_lost);
        let result = self
            .submit_on(
                connection,
                destination,
                spec,
                deadline.saturating_duration_since(tokio::time::Instant::now()),
                cancel.clone(),
                owner_lost.as_mut(),
                check_sender,
            )
            .await;
        let checked = tokio::time::timeout_at(
            deadline,
            final_owner_check(query, owner_lost.as_mut(), destination),
        )
        .await;
        self.phase = if matches!(checked, Ok(Ok(())))
            && !*cancel.borrow()
            && tokio::time::Instant::now() < deadline
        {
            result
        } else if self.attempted {
            Phase::Quarantined
        } else {
            Phase::NotSubmitted
        };
        if matches!(self.phase, Phase::Quarantined | Phase::NotSubmitted) {
            self.unit_binding = None;
        }
        self.phase.clone()
    }
    async fn submit_system(
        &mut self,
        spec: &LaunchSpec,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Phase {
        if self.used {
            self.unit_binding = None;
            return if self.attempted {
                Phase::Quarantined
            } else {
                Phase::NotSubmitted
            };
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let setup = async {
            let c = Builder::address("unix:path=/run/dbus/system_bus_socket")
                .map_err(|_| ())?
                .build()
                .await
                .map_err(|_| ())?;
            let bus = zbus::fdo::DBusProxy::new(&c).await.map_err(|_| ())?;
            let owner = bus
                .get_name_owner("org.freedesktop.systemd1".try_into().unwrap())
                .await
                .map_err(|_| ())?;
            if bus
                .get_connection_unix_user(owner.clone().into())
                .await
                .map_err(|_| ())?
                != 0
                || bus
                    .get_connection_unix_process_id(owner.clone().into())
                    .await
                    .map_err(|_| ())?
                    != 1
            {
                return Err(());
            }
            // Install before submitting. Any relevant transition quarantines, even ABA.
            let mut changes = bus.receive_name_owner_changed().await.map_err(|_| ())?;
            if bus
                .get_name_owner("org.freedesktop.systemd1".try_into().unwrap())
                .await
                .map_err(|_| ())?
                != owner
            {
                return Err(());
            }
            let lost = async {
                while let Some(event) = changes.next().await {
                    match event.args() {
                        Ok(a) if a.name().as_str() != "org.freedesktop.systemd1" => continue,
                        _ => return,
                    }
                }
            };
            let result = self
                .submit_and_finalize(
                    &c,
                    owner.as_str(),
                    spec,
                    deadline,
                    cancel.clone(),
                    lost,
                    true,
                    async {
                        bus.get_name_owner("org.freedesktop.systemd1".try_into().unwrap())
                            .await
                            .map(|v| v.to_string())
                            .map_err(|_| ())
                    },
                )
                .await;
            if *cancel.borrow() || tokio::time::Instant::now() >= deadline {
                return Err(());
            }
            Ok(result)
        };
        match tokio::time::timeout_at(deadline, setup).await {
            Ok(Ok(result)) => result,
            _ => {
                self.used = true;
                self.phase = if self.attempted {
                    Phase::Quarantined
                } else {
                    Phase::NotSubmitted
                };
                if matches!(self.phase, Phase::Quarantined | Phase::NotSubmitted) {
                    self.unit_binding = None;
                }
                self.phase.clone()
            }
        }
    }
    #[cfg(test)]
    async fn run(&mut self, fixture: &tests::Fixture, budget: Duration) -> Phase {
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        self.run_with_cancel(fixture, budget, receiver).await
    }
    #[cfg(test)]
    async fn run_with_cancel(
        &mut self,
        fixture: &tests::Fixture,
        budget: Duration,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Phase {
        if fixture.generation != self.generation {
            self.unit_binding = None;
            return if self.attempted {
                Phase::Quarantined
            } else {
                Phase::NotSubmitted
            };
        }

        self.submit_on(
            &fixture.client,
            "org.freedesktop.systemd1",
            &LaunchSpec::fixture(),
            budget,
            cancel,
            std::future::pending(),
            false,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)] // private context, never caller wire fields
    async fn observe<F: Future<Output = ()>>(
        &mut self,
        connection: &zbus::Connection,
        destination: &str,
        spec: &LaunchSpec,
        check_sender: bool,
        mut owner_lost: std::pin::Pin<&mut F>,
        cancel: tokio::sync::watch::Receiver<bool>,
        deadline: tokio::time::Instant,
    ) -> Result<Phase, ()> {
        let proxy = ManagerProxy::builder(connection)
            .destination(destination)
            .map_err(|_| ())?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|_| ())?;
        let mut signals = proxy.receive_job_removed().await.map_err(|_| ())?;

        tokio::select! { biased; _=owner_lost.as_mut()=>return Err(()), result=proxy.subscribe()=>result.map_err(|_|())? }
        // Recheck queued identity changes after Subscribe, immediately before mutation.
        if owner_lost.as_mut().now_or_never().is_some()
            || *cancel.borrow()
            || tokio::time::Instant::now() >= deadline
        {
            return Err(());
        }
        // Set before polling the mutating call. Lost response is never "not started".
        self.attempted = true;
        let start = proxy.start_transient_unit(spec.unit(), "fail", spec.properties(), vec![]);
        tokio::pin!(start);
        let mut returned: Option<(u32, String)> = None;
        let mut events: Vec<(u32, String, String, String)> = vec![];
        let mut bytes = 0usize;
        loop {
            tokio::select! { biased;
             _=owner_lost.as_mut()=>return Err(()),
             reply=&mut start,if returned.is_none()=>{
              let path=reply.map_err(|_|())?.to_string();
              let number=path.strip_prefix("/org/freedesktop/systemd1/job/").ok_or(())?;
              let id=number.parse::<u32>().map_err(|_|())?;
              if id==0||id.to_string()!=number{return Err(())}
              returned=Some((id,path));
             },
             signal=signals.next()=>{
              let signal=signal.ok_or(())?; validate_signal(&signal, destination, check_sender)?;let args=signal.args().map_err(|_|())?;
              let id=*args.id();let path=args.job().to_string();let unit=args.unit().to_string();let result=args.result().to_string();
              if path.len()>128||unit.len()>128||result.len()>32||!matches!(result.as_str(),"done"|"failed"|"canceled"|"timeout"|"dependency"|"skipped"){return Err(())}
              bytes+=path.len()+unit.len()+result.len()+4;
              if events.len()>=16||bytes>4096{return Err(())}
              events.push((id,path,unit,result));
             },
            }
            if let Some((id, path)) = &returned {
                // Drain only already queued signals before interpreting early completion.
                // This is bounded; later events require the future continuous reconciler.
                loop {
                    match signals.next().now_or_never() {
                        None => break,
                        Some(None) => return Err(()),
                        Some(Some(signal)) => {
                            validate_signal(&signal, destination, check_sender)?;
                            let args = signal.args().map_err(|_| ())?;
                            let path = args.job().to_string();
                            let unit = args.unit().to_string();
                            let result = args.result().to_string();
                            if path.len() > 128
                                || unit.len() > 128
                                || result.len() > 32
                                || !matches!(
                                    result.as_str(),
                                    "done"
                                        | "failed"
                                        | "canceled"
                                        | "timeout"
                                        | "dependency"
                                        | "skipped"
                                )
                            {
                                return Err(());
                            }
                            bytes += path.len() + unit.len() + result.len() + 4;
                            if events.len() >= 16 || bytes > 4096 {
                                return Err(());
                            }
                            events.push((*args.id(), path, unit, result));
                        }
                    }
                }
                let matching: Vec<_> = events
                    .iter()
                    .filter(|event| event.0 == *id && event.1 == *path && event.2 == spec.unit())
                    .collect();
                if matching.len() > 1 {
                    return Err(());
                }
                if let Some(event) = matching.first() {
                    if event.3 == "done" {
                        // Keep the same deadline/cancel/owner window as submission.
                        // A successful job is not enough to bind a unit incarnation.
                        let binding = tokio::select! { biased;
                            _ = owner_lost.as_mut() => return Err(()),
                            result = crate::unit_binding::read(connection, destination, spec.unit()) => result?,
                        };
                        self.unit_binding = Some(binding);
                    }
                    return Ok(Phase::JobObserved {
                        job_id: *id,
                        result: event.3.clone(),
                    });
                }
            }
        }
    }
    fn reconnect(&mut self, generation: u64) -> Result<(), ()> {
        if generation <= self.generation {
            return Err(());
        }
        self.generation = generation;
        self.unit_binding = None;
        if self.attempted {
            self.phase = Phase::Quarantined
        }
        // Deliberately keep used=true: reconnect is not authorization to retry start.
        Ok(())
    }
    fn must_retain(&self) -> bool {
        self.attempted
    }
}

fn validate_signal(signal: &JobRemoved, destination: &str, check_sender: bool) -> Result<(), ()> {
    let h = signal.message().header();
    if h.path().map(|v| v.as_str()) != Some("/org/freedesktop/systemd1")
        || h.interface().map(|v| v.as_str()) != Some("org.freedesktop.systemd1.Manager")
        || h.member().map(|v| v.as_str()) != Some("JobRemoved")
        || (check_sender && h.sender().map(|v| v.as_str()) != Some(destination))
    {
        return Err(());
    }
    Ok(())
}
#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;

// Final roundtrip is part of the same owner observation window.
async fn final_owner_check<Q, F>(
    query: Q,
    mut owner_lost: std::pin::Pin<&mut F>,
    expected: &str,
) -> Result<(), ()>
where
    Q: Future<Output = Result<String, ()>>,
    F: Future<Output = ()>,
{
    let actual =
        tokio::select! {biased; _=owner_lost.as_mut()=>return Err(()), result=query=>result?};
    // Cover queued transitions through this final reply, not future changes after return.
    if owner_lost.as_mut().now_or_never().is_some() || actual != expected {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod container_diagnostic {
    use super::*;
    #[tokio::test]
    #[ignore = "requires operator-audited Ubuntu Docker systemd container; benign sleep only"]
    async fn fixed_sleep_unit_times_out() {
        crate::container_probe::preflight()
            .expect("container preflight refused; do not relax host security");
        tokio::time::timeout(Duration::from_secs(20), async {
        crate::manager_diagnostic::inspect_system_manager().await.expect("private manager unavailable");
        let connection=Builder::address("unix:path=/run/dbus/system_bus_socket").unwrap().build().await.unwrap();
        let bus=zbus::fdo::DBusProxy::new(&connection).await.unwrap();
        let owner=bus.get_name_owner("org.freedesktop.systemd1".try_into().unwrap()).await.unwrap();
        let (_tx,rx)=tokio::sync::watch::channel(false);
        let spec=LaunchSpec::container_probe();
        let phase=Attempt::new(1).submit_system(&spec,rx).await;
        assert!(matches!(phase,Phase::JobObserved{ref result,..} if result=="done"),"unconfirmed submit: {phase:?}; never retry blindly");
        assert_eq!(bus.get_name_owner("org.freedesktop.systemd1".try_into().unwrap()).await.unwrap(),owner);
        tokio::time::timeout(Duration::from_secs(10),async {
            let manager=zbus::Proxy::new(&connection,owner.as_str(),"/org/freedesktop/systemd1","org.freedesktop.systemd1.Manager").await.unwrap();
            let path:OwnedObjectPath=manager.call("GetUnit",&(spec.unit(),)).await.unwrap();
            let service=zbus::Proxy::new(&connection,owner.as_str(),path.as_str(),"org.freedesktop.systemd1.Service").await.unwrap();
            assert_eq!(service.get_property::<u64>("RuntimeMaxUSec").await.unwrap(),2_000_000);
            assert_eq!(service.get_property::<u64>("MemoryMax").await.unwrap(),64_000_000);
            assert_eq!(service.get_property::<u64>("TasksMax").await.unwrap(),8);
            assert!(service.get_property::<bool>("DynamicUser").await.unwrap());
            loop {
                let result=service.get_property::<String>("Result").await.unwrap();
                let pid=service.get_property::<u32>("MainPID").await.unwrap();
                if result=="timeout" && pid==0 {break}
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert_eq!(bus.get_name_owner("org.freedesktop.systemd1".try_into().unwrap()).await.unwrap(),owner);
        }).await.expect("unit stop unconfirmed; operator must inspect fixed probe unit");
        println!("{{\"scope\":\"benign-container-manager-diagnostic\",\"fixed_sleep_timeout_observed\":true,\"execution_available\":false,\"isolation_certified\":false}}");
        }).await.expect("diagnostic deadline exceeded; inspect probe unit, do not retry blindly");
    }
}
